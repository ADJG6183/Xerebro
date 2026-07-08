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
 *    (EventArchitecture.md provenance rule). Known debt: if the push fails
 *    offline there is no outbox yet — the record returns to the caller but
 *    isn't durable; outbox is scheduled with the persistence milestone.
 */
import {
  buildRecommendationRecord,
  computeFinancialState,
  decidePurchase,
  emptyProjection,
  applyEvents,
  foldAccounts,
  foldBills,
  foldBuckets,
  renderTemplateExplanation,
  verifyHighStakes,
  PURCHASE_REQUIRED_INPUTS,
  PURCHASE_FRESHNESS_WINDOW_SECONDS,
  type Account,
  type EventEnvelope,
  type RecommendationRecord,
  type TransactionEvent,
} from "@xerebro/engines";
import type { DeviceEventLog } from "./deviceLog";
import { pullOnce, pushUserEvents, type SyncTransport } from "./syncClient";
import { makeUserEvent, type EventFactoryDeps } from "./userEvents";

const TRANSACTION_TYPES = new Set([
  "TransactionPosted",
  "TransactionUpdated",
  "TransactionRemoved",
  "TransactionAnnotated",
]);

export interface DecisionFlowDeps {
  log: DeviceEventLog;
  transport: SyncTransport;
  factory: EventFactoryDeps;
  userId: string;
  refreshTimeoutMs?: number; // verificationEngine.md: 3s
}

export interface PurchaseCheckResult {
  record: RecommendationRecord;
  explanation: string;
  /** True when state is computed from manual accounts only. */
  manualDataOnly: boolean;
  /** True when sync/refresh could not reach the server. */
  offline: boolean;
  recordPersisted: boolean;
}

export async function runPurchaseCheck(
  deps: DecisionFlowDeps,
  amountMinor: number,
  description?: string,
): Promise<PurchaseCheckResult> {
  const nowIso = deps.factory.nowIso();
  let offline = false;

  try {
    await pullOnce(deps.transport, deps.log, deps.userId);
  } catch {
    offline = true;
  }

  let snapshot = await computeSnapshot(deps.log, nowIso);

  // Refresh-race: only aggregator accounts can be stale (manual are exempt).
  if (snapshot.aggregatorAgeSeconds > PURCHASE_FRESHNESS_WINDOW_SECONDS) {
    const refreshed = await raceRefresh(deps, snapshot.staleItemIds);
    if (refreshed) {
      try {
        await pullOnce(deps.transport, deps.log, deps.userId);
        snapshot = await computeSnapshot(deps.log, nowIso);
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
    // Device-side drift is 0 for manual accounts by construction (the ledger
    // IS the reported balance). Plaid drift scoring needs full-history
    // windows — arrives with the balance-sync milestone.
    driftMinor: 0,
    reportedBalanceMinor: snapshot.state.availableCashMinor,
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

  let recordPersisted = false;
  try {
    await pushUserEvents(deps.transport, deps.log, deps.userId, [
      makeUserEvent(deps.factory, "RecommendationRecorded", record, `rec:${record.recommendationId}`),
    ]);
    recordPersisted = true;
  } catch {
    offline = true;
  }

  return {
    record,
    explanation,
    manualDataOnly: snapshot.manualDataOnly,
    offline,
    recordPersisted,
  };
}

export async function submitFeedback(
  deps: DecisionFlowDeps,
  recommendationId: string,
  response: "accepted" | "ignored" | "rejected",
): Promise<boolean> {
  try {
    await pushUserEvents(deps.transport, deps.log, deps.userId, [
      makeUserEvent(
        deps.factory,
        "FeedbackSubmitted",
        { recommendationId, response, createdAt: deps.factory.nowIso() },
        `feedback:${recommendationId}`,
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function computeSnapshot(log: DeviceEventLog, nowIso: string) {
  const events: EventEnvelope[] = await log.all();
  const accounts = foldAccounts(events);
  const projection = applyEvents(
    emptyProjection(),
    events.filter((e): e is TransactionEvent => TRANSACTION_TYPES.has(e.type)),
  );
  const state = computeFinancialState({
    accounts,
    projection,
    buckets: foldBuckets(events),
    bills: foldBills(events),
    todayLocal: nowIso.slice(0, 10),
  });

  const aggregator = accounts.filter(
    (a: Account) => a.source === "plaid" && a.status === "active",
  );
  const manualDataOnly = aggregator.length === 0;
  const oldest = aggregator.map((a) => a.balanceAsOf).sort()[0];
  const aggregatorAgeSeconds = oldest
    ? Math.max(0, (Date.parse(nowIso) - Date.parse(oldest)) / 1000)
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

/** Fire refreshes with the doc's timeout; report whether ANY completed. */
async function raceRefresh(deps: DecisionFlowDeps, itemIds: string[]): Promise<boolean> {
  if (itemIds.length === 0 || deps.transport.refreshItem === undefined) return false;
  const timeoutMs = deps.refreshTimeoutMs ?? 3_000;
  const results = await Promise.all(
    itemIds.map((id) =>
      withTimeout(deps.transport.refreshItem!(id), timeoutMs).then(
        () => true,
        () => false,
      ),
    ),
  );
  return results.some(Boolean);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
