/**
 * Plaid anti-corruption layer: transactions/sync pages → Xerebro events
 * (docs/adr/ADR-003-events.md).
 *
 * Vendor translation happening here — the ONLY place these conventions exist:
 *  - float dollars → signed integer minor units (Plaid positive = outflow,
 *    ours negative = outflow). The float dies at this boundary.
 *  - pending→posted: Plaid reports it as removed(pending id) + added(new id,
 *    pending_transaction_id set). We rewrite that to a single
 *    TransactionUpdated on the canonical (pending) id and SUPPRESS the
 *    phantom removal. A hold that never posts arrives as removed alone and
 *    becomes a real TransactionRemoved (tombstone downstream).
 *  - idempotency: one fetched page = one batch keyed (itemId, cursor); the
 *    event store makes replays a no-op (docs/SystemInvariants.md).
 */
import type { CategoryConfidence, MinorUnits } from "@xerebro/engines";
import type { UnsequencedEvent, EventStore } from "../eventStore";
import type { PlaidGateway, PlaidSyncPage, PlaidTransaction } from "./gateway";
import type { ItemStore, PlaidItem, TxnRegistry } from "./stores";
import type { TokenVault } from "./tokenVault";

/** Access tokens are stored sealed; open them only at the call site. */
export function accessTokenOf(deps: AclDeps, item: PlaidItem): string {
  return deps.tokens ? deps.tokens.open(item.accessTokenRef) : item.accessTokenRef;
}

export interface AclDeps {
  plaid: PlaidGateway;
  events: EventStore;
  items: ItemStore;
  registry: TxnRegistry;
  /** Decrypts stored access tokens just-in-time (plaid/tokenVault.ts).
   * Absent = the stored value IS the token (dev/tests). */
  tokens?: TokenVault;
  /** Injected clock — deterministic in tests. */
  now: () => string;
  /** Injected id generator — deterministic in tests. */
  newEventId: () => string;
}

/** Plaid positive = outflow; Xerebro negative = outflow. Float ends here. */
export function toMinorUnits(plaidAmount: number): MinorUnits {
  return -Math.round(plaidAmount * 100);
}

export interface SyncOutcome {
  pages: number;
  appended: number;
  dedupedPages: number;
}

/** Drain transactions/sync for one item (webhooks are notifications-to-fetch). */
export async function syncPlaidItem(deps: AclDeps, itemId: string): Promise<SyncOutcome> {
  const item = await deps.items.get(itemId);
  if (!item) throw new Error(`unknown plaid item ${itemId}`);

  const outcome: SyncOutcome = { pages: 0, appended: 0, dedupedPages: 0 };
  let cursor = item.cursor;

  // Bounded drain. Plaid always advances next_cursor, but an aggregator bug
  // (or a misconfigured fake) that returns has_more with an UNCHANGED cursor
  // would spin forever, holding a request open and appending nothing. A
  // never-terminating loop is not an acceptable failure mode for a webhook
  // handler, so we bound it two ways: no cursor progress, or a page cap.
  const MAX_PAGES = 100; // 100 × 500 txns = 50k, far beyond any real sync
  while (outcome.pages < MAX_PAGES) {
    const page = await deps.plaid.transactionsSync(accessTokenOf(deps, item), cursor);
    const events = await normalizePage(deps, item.userId, page);
    const result = await deps.events.appendBatch(
      item.userId,
      events,
      `plaid:${itemId}:${cursor}`,
    );

    outcome.pages += 1;
    outcome.appended += result.appended.length;
    if (result.deduped) outcome.dedupedPages += 1;

    await deps.items.setCursor(itemId, page.next_cursor);
    const advanced = page.next_cursor !== cursor;
    cursor = page.next_cursor;
    if (!page.has_more || !advanced) break;
  }
  return outcome;
}

/** Plaid's confidence vocabulary → ours. Unknown/missing degrades to
 * "unknown", never to false certainty (docs/SystemInvariants.md). */
function toConfidence(level: string | null | undefined): CategoryConfidence {
  switch (level) {
    case "VERY_HIGH":
      return "very_high";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "unknown";
  }
}

/** Trim, collapse whitespace, and drop empties — real feeds send `"  "`. */
function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

/** Only accept image URLs Plaid actually serves over https. */
function cleanUrl(value: string | null | undefined): string | undefined {
  const url = clean(value);
  return url?.startsWith("https://") ? url : undefined;
}

/**
 * Accept the aggregator's "clean" merchant name only when it's actually an
 * improvement. Observed in real sandbox data: "SparkFun" came back as "FUN"
 * — a truncation that is strictly WORSE than the bank's own description.
 *
 * Rule: keep it when it's a distinct name that isn't a bare fragment of the
 * raw text. A name that's just a substring of the raw description adds
 * nothing (at best) or loses information (at worst), so the raw wins.
 */
function usefulMerchantName(
  candidate: string | undefined,
  merchantRaw: string,
): string | undefined {
  if (!candidate || candidate === merchantRaw) return undefined;
  const rawUpper = merchantRaw.toUpperCase();
  const candidateUpper = candidate.toUpperCase();

  // "Uber" from "Uber 063015 SF**POOL**" — a leading prefix is a clean-up.
  if (rawUpper.startsWith(candidateUpper)) return candidate;

  // Multi-word names are real merchant resolutions, never truncations:
  // "SQ *BLUE BOTTLE" → "Blue Bottle Coffee" is exactly what we want.
  if (/\s/.test(candidate.trim())) return candidate;

  // A single word buried INSIDE the raw text is a fragment, not a name:
  // "SparkFun" → "FUN" loses information, so the bank's text wins.
  const glued = rawUpper.replace(/[^A-Z0-9]/g, "");
  if (glued.includes(candidateUpper.replace(/[^A-Z0-9]/g, ""))) return undefined;

  return candidate;
}

/**
 * The ONE place Plaid's transaction fields become ours — shared by the
 * "new transaction" and "pending became posted" paths so enrichment can
 * never drift between them.
 *
 * Edge cases handled here, all observed in real aggregator data:
 *  - `merchant_name` absent (rare merchants) → display falls back to raw;
 *  - `merchant_name` equal to the raw description → don't store a duplicate;
 *  - blank/whitespace strings → treated as absent, never stored as "";
 *  - non-https or missing logo URLs → dropped;
 *  - `iso_currency_code` null on some accounts → `unofficial_currency_code`;
 *  - category present but low-confidence → kept WITH its confidence, so the
 *    UI and copilot can be honest about a guess.
 */
function enrich(txn: PlaidTransaction) {
  const merchantRaw = clean(txn.name) ?? "Unknown";
  const merchantName = usefulMerchantName(clean(txn.merchant_name), merchantRaw);
  const category = clean(txn.personal_finance_category?.primary);

  return {
    amountMinor: toMinorUnits(txn.amount),
    merchantRaw,
    // Storing the clean name only when it ADDS something keeps payloads
    // small and makes "did Plaid actually resolve this merchant?" answerable.
    ...(merchantName ? { merchantName } : {}),
    ...(cleanUrl(txn.logo_url) ? { merchantLogoUrl: cleanUrl(txn.logo_url)! } : {}),
    ...(category ? { category } : {}),
    ...(clean(txn.personal_finance_category?.detailed)
      ? { categoryDetailed: clean(txn.personal_finance_category?.detailed)! }
      : {}),
    // Confidence only means something alongside a category.
    ...(category
      ? { categoryConfidence: toConfidence(txn.personal_finance_category?.confidence_level) }
      : {}),
    ...(clean(txn.payment_channel) ? { paymentChannel: clean(txn.payment_channel)! } : {}),
  };
}

async function normalizePage(
  deps: AclDeps,
  userId: string,
  page: PlaidSyncPage,
): Promise<UnsequencedEvent[]> {
  const events: UnsequencedEvent[] = [];
  /** Pending ids superseded by a posting in THIS page — their `removed`
   * entries are phantoms and must not become tombstones. */
  const superseded = new Set<string>();

  for (const txn of page.added) {
    const pendingId = txn.pending_transaction_id;
    if (pendingId && (await deps.registry.has(userId, pendingId))) {
      // Pending → posted: same canonical transaction, status change.
      superseded.add(pendingId);
      await deps.registry.addAlias(userId, txn.transaction_id, pendingId);
      events.push(
        makeEvent(deps, "TransactionUpdated", {
          txnId: pendingId,
          changes: { status: "posted" as const, postedDate: txn.date, ...enrich(txn) },
        }),
      );
    } else {
      await deps.registry.add(userId, txn.transaction_id);
      events.push(
        makeEvent(deps, "TransactionPosted", {
          txnId: txn.transaction_id,
          accountId: txn.account_id,
          currency: txn.iso_currency_code ?? txn.unofficial_currency_code ?? "USD",
          status: txn.pending ? ("pending" as const) : ("posted" as const),
          postedDate: txn.date,
          ...(txn.authorized_date ? { authorizedDate: txn.authorized_date } : {}),
          categorySource: "plaid" as const,
          ...enrich(txn),
        }),
      );
    }
  }

  for (const txn of page.modified) {
    const canonical = await canonicalId(deps, userId, txn.transaction_id);
    events.push(
      makeEvent(deps, "TransactionUpdated", {
        txnId: canonical,
        // Same extractor as the added path: enrichment can't drift.
        changes: enrich(txn),
      }),
    );
  }

  for (const removal of page.removed) {
    if (superseded.has(removal.transaction_id)) continue; // phantom: it posted
    const canonical = await canonicalId(deps, userId, removal.transaction_id);
    events.push(
      makeEvent(deps, "TransactionRemoved", {
        txnId: canonical,
        reason: "removed by aggregator",
      }),
    );
  }

  return events;
}

async function canonicalId(deps: AclDeps, userId: string, plaidId: string): Promise<string> {
  return (await deps.registry.aliasFor(userId, plaidId)) ?? plaidId;
}

function makeEvent(deps: AclDeps, type: string, payload: unknown): UnsequencedEvent {
  const eventId = deps.newEventId();
  return {
    eventId,
    type,
    schemaVersion: 1,
    occurredAt: deps.now(),
    source: "plaid",
    idempotencyKey: `plaid-evt:${eventId}`,
    payload,
  };
}

export type { PlaidTransaction };
