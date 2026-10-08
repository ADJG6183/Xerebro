/**
 * The "Can I buy this?" pipeline, on-device (ADR-001), implementing the
 * refresh-race from docs/verificationEngine.md:
 *
 *   pull → fold state → decide → [stale? refresh with timeout → re-pull]
 *        → verify → template explanation → RecommendationRecorded → feedback
 *
 * Doc rules made concrete here:
 *  - Manual accounts are freshness-exempt (verificationEngine.md): no bank
 *    feed, no staleness. Aggregator accounts govern the window when present.
 *  - The decision ALWAYS renders, verified or not — verification decides how
 *    it's labeled, never whether the user is left hanging (performanceBudget).
 *  - The audit record is pushed as a RecommendationRecorded user event
 *    (EventArchitecture.md provenance rule), through the outbox: durable
 *    locally even fully offline, flushed with producer-idempotent retries.
 */
import {
  buildRecommendationRecord,
  buildSnapshot,
  checkFaithfulness,
  computeFinancialState,
  decidePurchase,
  renderTemplateExplanation,
  verifyHighStakes,
  PURCHASE_REQUIRED_INPUTS,
  PURCHASE_FRESHNESS_WINDOW_SECONDS,
  type Account,
  type RecommendationRecord,
} from "@xerebro/engines";
import type { DeviceEventLog } from "./deviceLog";
import type { ProjectionCache } from "./projectionCache";
import { failureOf, type AggregatorFailure } from "./aggregatorStatus";
import { withPending, type Outbox } from "./outbox";
import { flushOutbox, pullOnce, sendOrQueue, type SyncTransport } from "./syncClient";
import { makeUserEvent, type EventFactoryDeps } from "./userEvents";
import { withTimeout } from "./withTimeout";

export interface DecisionFlowDeps {
  log: DeviceEventLog;
  outbox: Outbox;
  transport: SyncTransport;
  factory: EventFactoryDeps;
  userId: string;
  /** User-profile/device calendar date. Older callers fall back to UTC. */
  todayLocal?: () => string;
  refreshTimeoutMs?: number; // verificationEngine.md: 3s
  /** Shared fold cache (projectionCache.ts). Absent = fold from scratch,
   * which tests and one-off callers use. */
  projections?: ProjectionCache;
}

export interface PurchaseCheckResult {
  record: RecommendationRecord;
  explanation: string;
  /** True when state is computed from manual accounts only. */
  manualDataOnly: boolean;
  /** True when sync/refresh could not reach the server. */
  offline: boolean;
  /** "synced" = audit record on the server; "queued" = durable in the
   * outbox, flushes when the network returns. Never lost either way. */
  recordStatus: "synced" | "queued";
  /** Set when a bank refresh failed for a REASON worth telling the user
   * (docs/Reliability.md) — e.g. their bank needs a fresh sign-in. */
  aggregatorFailure?: AggregatorFailure;
}

/** One deadline for the whole pull → maybe-refresh → maybe-re-pull sequence
 * (performanceBudget.md's refresh-race cap), not a fresh window per leg —
 * three independently-bounded 3s legs could otherwise stack to ~9s for one
 * check, which is not what "4s cap" means. */
const OVERALL_NETWORK_BUDGET_MS = 4_000;

export async function runPurchaseCheck(
  deps: DecisionFlowDeps,
  amountMinor: number,
  description?: string,
): Promise<PurchaseCheckResult> {
  const nowIso = deps.factory.nowIso();
  let offline = false;
  let aggregatorFailure: AggregatorFailure | undefined;

  const overallBudgetMs = deps.refreshTimeoutMs ?? OVERALL_NETWORK_BUDGET_MS;
  const deadline = Date.now() + overallBudgetMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  // A stalled initial pull must not hang the whole check — fall through on
  // the local cache instead (performanceBudget.md: never block on network).
  try {
    await withTimeout(pullOnce(deps.transport, deps.log), remainingMs());
  } catch {
    offline = true;
  }

  let snapshot = await computeSnapshot(deps, nowIso);

  // Refresh-race: only aggregator accounts can be stale (manual are exempt).
  // Whatever's left of the SAME overall budget, not a fresh 3s on top of
  // what the initial pull already spent.
  if (snapshot.aggregatorAgeSeconds > PURCHASE_FRESHNESS_WINDOW_SECONDS && remainingMs() > 0) {
    const race = await raceRefresh(deps, snapshot.staleItemIds, remainingMs());
    if (race.failure) aggregatorFailure = race.failure;
    if (race.refreshed) {
      try {
        await withTimeout(pullOnce(deps.transport, deps.log), remainingMs());
        snapshot = await computeSnapshot(deps, nowIso);
      } catch {
        offline = true;
      }
    }
  }

  const decision = decidePurchase(snapshot.state, {
    amountMinor,
    ...(description !== undefined ? { description } : {}),
  });

  const verification = verifyHighStakes({
    dataAgeSeconds: snapshot.manualDataOnly ? 0 : snapshot.aggregatorAgeSeconds,
    requiredInputs: PURCHASE_REQUIRED_INPUTS,
    snapshot: snapshot.state as unknown as Record<string, unknown>,
    reconciliationRequired: !snapshot.manualDataOnly,
    ...(snapshot.state.reconciliationDriftMinor !== undefined
      ? { driftMinor: snapshot.state.reconciliationDriftMinor }
      : {}),
    ...(snapshot.state.reportedBalanceMinor !== undefined
      ? { reportedBalanceMinor: snapshot.state.reportedBalanceMinor }
      : {}),
    dataQualityIssues: financialDataQualityIssues(snapshot.state),
  });

  const explanation = renderTemplateExplanation(decision, verification);

  const record = buildRecommendationRecord({
    recommendationId: deps.factory.newId(),
    userId: deps.userId,
    createdAt: nowIso,
    decision,
    verification,
    templateExplanation: explanation,
  });

  // The audit record is durable BEFORE anything renders (SystemInvariants.md)
  // — but durable-locally is as far as this function waits. Uploading it is
  // explicitly allowed to happen later (rocketMoneyMvpSpec.md §8: "Queue-
  // first audit persistence precedes display; remote audit upload can
  // happen later") — awaiting the flush here would add unbounded-feeling
  // network latency to every purchase check even when the verdict itself
  // is already final. Not awaited; flushOutbox's own per-outbox mutex
  // (syncClient.ts) makes this safe to race against any later write.
  await deps.outbox.enqueue([
    makeUserEvent(deps.factory, "RecommendationRecorded", record, `rec:${record.recommendationId}`),
  ]);
  void flushOutbox(deps.transport, deps.log, deps.outbox).catch(() => {});

  return {
    record,
    explanation,
    manualDataOnly: snapshot.manualDataOnly,
    offline,
    // Accurate at THIS instant by construction: the record is durable in
    // the outbox and the upload has not been confirmed (it hasn't been
    // awaited at all). "synced" would be a claim this function never
    // checked.
    recordStatus: "queued",
    ...(aggregatorFailure ? { aggregatorFailure } : {}),
  };
}

export interface EnhancedExplanation {
  text: string;
  provider: string;
  model: string;
}

/**
 * Beat 2 (docs/AIArchitecture.md two-beat delivery): ask the proxy for the
 * LLM explanation. On success: re-check faithfulness ON DEVICE (defense in
 * depth — the client doesn't have to trust the server's diligence), push a
 * RecommendationExplanationAdded amendment, and hand the richer text to the
 * UI. On ANY failure — proxy absent, network, 422/503, unfaithful — return
 * null and the template explanation simply stands.
 */
export async function enhanceExplanation(
  deps: DecisionFlowDeps,
  record: RecommendationRecord,
): Promise<EnhancedExplanation | null> {
  if (deps.transport.getExplanation === undefined) return null;
  try {
    const res = await deps.transport.getExplanation({
      decision: record.decision,
      verification: record.verification,
    });
    if (!checkFaithfulness(res.text, record.decision).faithful) return null;

    await sendOrQueue(deps.transport, deps.log, deps.outbox, [
      makeUserEvent(
        deps.factory,
        "RecommendationExplanationAdded",
        {
          recommendationId: record.recommendationId,
          llm: {
            provider: res.provider,
            model: res.model,
            promptTemplateVersion: res.promptTemplateVersion,
            explanationTextVerbatim: res.text,
          },
        },
        `rec-explain:${record.recommendationId}`,
      ),
    ]);
    return { text: res.text, provider: res.provider, model: res.model };
  } catch {
    return null;
  }
}

/** Returns true when the feedback is durable (synced OR queued for flush). */
export async function submitFeedback(
  deps: DecisionFlowDeps,
  recommendationId: string,
  response: "accepted" | "ignored" | "rejected",
): Promise<boolean> {
  await sendOrQueue(deps.transport, deps.log, deps.outbox, [
    makeUserEvent(
      deps.factory,
      "FeedbackSubmitted",
      { recommendationId, response, createdAt: deps.factory.nowIso() },
      `feedback:${recommendationId}`,
    ),
  ]);
  return true;
}

async function computeSnapshot(deps: DecisionFlowDeps, nowIso: string) {
  // Decisions and the dashboard must read the SAME financial picture. User
  // actions are durable in the outbox before they reach the server, so they
  // already affect affordability (otherwise an offline expense can vanish
  // from a high-stakes check while still appearing on the dashboard).
  const pending = await deps.outbox.all();
  const folded = deps.projections
    ? await deps.projections.withPending(deps.log, pending)
    : buildSnapshot(withPending(await deps.log.all(), pending));
  const { accounts, transactions: projection, buckets, bills } = folded;
  const state = computeFinancialState({
    accounts,
    projection,
    buckets,
    bills,
    todayLocal: deps.todayLocal?.() ?? nowIso.slice(0, 10),
  });

  const balanceRelevantIds = new Set(state.accountBalances.map((balance) => balance.accountId));
  const aggregator = accounts.filter(
    (a: Account) =>
      a.source === "plaid" && a.status === "active" && balanceRelevantIds.has(a.accountId),
  );
  const manualDataOnly = aggregator.length === 0;
  const oldest = aggregator.map((a) => a.balanceAsOf).sort()[0];
  const parsedOldest = oldest ? Date.parse(oldest) : Number.NaN;
  const aggregatorAgeSeconds = oldest
    ? Number.isFinite(parsedOldest)
      ? Math.max(0, (Date.parse(nowIso) - parsedOldest) / 1000)
      : Number.MAX_SAFE_INTEGER
    : 0;
  const staleItemIds = [
    ...new Set(
      aggregator
        .filter(
          (a) =>
            (Date.parse(nowIso) - Date.parse(a.balanceAsOf)) / 1000 >
            PURCHASE_FRESHNESS_WINDOW_SECONDS,
        )
        .map((a) => a.plaidItemId)
        .filter((id): id is string => id !== undefined),
    ),
  ];

  return { state, manualDataOnly, aggregatorAgeSeconds, staleItemIds };
}

function financialDataQualityIssues(state: ReturnType<typeof computeFinancialState>): string[] {
  const issues: string[] = [...state.historyWarnings];
  if (state.unsupportedCurrencyAccountIds.length > 0) {
    issues.push("Some active accounts use a currency that is excluded from the USD total");
  }
  if (state.unknownTypeAccountIds.length > 0) {
    issues.push("Some active accounts have an unknown type and may not be spendable");
  }
  if (state.unknownBalanceAccountIds.length > 0) {
    issues.push("Some active bank accounts did not report a usable balance");
  }
  if (state.unsupportedCurrencyTransactionIds.length > 0) {
    issues.push("Some transactions use a currency that is excluded from USD calculations");
  }
  if (state.reconciliationStatus === "failed") {
    issues.push("The bank balance does not reconcile with imported transaction history");
  }
  return issues;
}

/** Fire refreshes with the doc's timeout; report whether ANY completed,
 * and surface a classified failure when one is worth showing. */
interface RefreshOutcome {
  refreshed: boolean;
  /** A CLASSIFIED failure worth telling the user about (never a timeout). */
  failure?: AggregatorFailure;
}

async function raceRefresh(
  deps: DecisionFlowDeps,
  itemIds: string[],
  timeoutMs: number,
): Promise<RefreshOutcome> {
  if (itemIds.length === 0 || deps.transport.refreshItem === undefined) {
    return { refreshed: false };
  }
  const results = await Promise.all(
    itemIds.map((id) =>
      withTimeout(deps.transport.refreshItem!(id), timeoutMs).then(
        () => ({ ok: true }) as const,
        // A timeout is expected (verification degrades to CANT_VERIFY); a
        // CLASSIFIED failure means the bank told us something actionable.
        (err) => ({ ok: false, failure: failureOf(err) }) as const,
      ),
    ),
  );
  const failure = results.flatMap((r) => (r.ok ? [] : (r.failure ?? [])))[0];
  return {
    refreshed: results.some((r) => r.ok),
    ...(failure ? { failure } : {}),
  };
}
