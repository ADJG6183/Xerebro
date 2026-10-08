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
 *  - consistency: every page in one cursor update is normalized together,
 *    then events, identity links, and the final cursor commit atomically.
 */
import { validateEventPayload, type CategoryConfidence, type MinorUnits } from "@xerebro/engines";
import type { UnsequencedEvent, EventStore } from "../eventStore";
import type { PlaidGateway, PlaidSyncPage, PlaidTransaction } from "./gateway";
import type { ItemStore, PlaidIngestionStore, PlaidItem, TxnRegistry } from "./stores";
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
  /** Required by transaction ingestion; optional only for manual-only app
   * assemblies that never call syncPlaidItem. */
  ingestion?: PlaidIngestionStore;
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
export async function syncPlaidItem(deps: AclDeps, itemId: string, allowedAccountIds?: ReadonlySet<string>): Promise<SyncOutcome> {
  if (!deps.ingestion) throw new Error("atomic Plaid ingestion store is not configured");

  // A webhook and a user refresh can race. Fetch without DB locks, then let
  // the atomic commit compare the starting cursor. A loser refetches from the
  // winner's cursor instead of applying stale pages.
  const MAX_CURSOR_CONFLICT_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_CURSOR_CONFLICT_RETRIES; attempt++) {
    const item = await deps.items.get(itemId);
    if (!item) throw new Error(`unknown plaid item ${itemId}`);
    if (item.status === "disconnecting" || item.status === "disconnected") {
      throw new Error(`Plaid item ${itemId} is disconnected`);
    }
    const pages = await fetchCompleteUpdate(deps.plaid, accessTokenOf(deps, item), item.cursor);
    if (allowedAccountIds && pages.some((page) => [...page.added, ...page.modified].some((txn) => !allowedAccountIds.has(txn.account_id)))) {
      throw new Error("Transaction account details are missing; retry account import first");
    }
    const normalized = await normalizeUpdate(deps, item.userId, pages);
    const nextCursor = pages[pages.length - 1]!.next_cursor;
    const committed = await deps.ingestion.commit({
      itemId,
      userId: item.userId,
      expectedCursor: item.cursor,
      nextCursor,
      events: normalized.events,
      knownTxnIds: normalized.knownTxnIds,
      aliases: normalized.aliases,
    });
    if (committed.committed) {
      return { pages: pages.length, appended: committed.appended, dedupedPages: 0 };
    }
  }
  throw new Error(`Plaid cursor kept changing for item ${itemId}`);
}

const MAX_PAGES = 100; // 100 × 500 txns = 50k, beyond an ordinary update.
const MAX_MUTATION_RESTARTS = 3;

async function fetchCompleteUpdate(
  plaid: PlaidGateway,
  accessToken: string,
  startingCursor: string,
): Promise<PlaidSyncPage[]> {
  for (let restart = 0; restart < MAX_MUTATION_RESTARTS; restart++) {
    const pages: PlaidSyncPage[] = [];
    let cursor = startingCursor;
    try {
      while (pages.length < MAX_PAGES) {
        const page = await plaid.transactionsSync(accessToken, cursor);
        assertSyncPage(page);
        const hasChanges = page.added.length + page.modified.length + page.removed.length > 0;
        if (page.next_cursor === cursor && (page.has_more || hasChanges)) {
          throw new Error("Plaid cursor did not advance for a non-empty update");
        }
        pages.push(page);
        if (!page.has_more) return pages;
        cursor = page.next_cursor;
      }
      throw new Error(`Plaid update exceeded ${MAX_PAGES} pages`);
    } catch (error) {
      if (!isPaginationMutation(error) || restart === MAX_MUTATION_RESTARTS - 1) throw error;
      // Plaid requires the whole pagination loop to restart from its original cursor.
    }
  }
  throw new Error("unreachable Plaid pagination state");
}

function assertSyncPage(page: PlaidSyncPage): void {
  if (
    !page ||
    !Array.isArray(page.added) ||
    !Array.isArray(page.modified) ||
    !Array.isArray(page.removed) ||
    typeof page.next_cursor !== "string" ||
    typeof page.has_more !== "boolean"
  ) {
    throw new TypeError("invalid Plaid transactions/sync page");
  }
  if (
    ![...page.added, ...page.modified].every(isPlaidTransaction) ||
    !page.removed.every(
      (removal) =>
        typeof removal === "object" &&
        removal !== null &&
        typeof removal.transaction_id === "string" &&
        removal.transaction_id.length > 0,
    )
  ) {
    throw new TypeError("invalid transaction in Plaid transactions/sync page");
  }
}

function isPlaidTransaction(txn: unknown): txn is PlaidTransaction {
  if (typeof txn !== "object" || txn === null) return false;
  const value = txn as Partial<PlaidTransaction>;
  return (
    typeof value.transaction_id === "string" &&
    value.transaction_id.length > 0 &&
    typeof value.account_id === "string" &&
    value.account_id.length > 0 &&
    typeof value.amount === "number" &&
    Number.isFinite(value.amount) &&
    typeof value.pending === "boolean" &&
    typeof value.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    typeof value.name === "string"
  );
}

function isPaginationMutation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "plaidErrorCode" in error &&
    error.plaidErrorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
  );
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

async function normalizeUpdate(
  deps: AclDeps,
  userId: string,
  pages: readonly PlaidSyncPage[],
): Promise<{
  events: UnsequencedEvent[];
  knownTxnIds: string[];
  aliases: { plaidId: string; canonicalId: string }[];
}> {
  const allAdded = pages.flatMap((page) => page.added);
  const lookupIds = pages.flatMap((page) => [
    ...page.added.flatMap((txn) => txn.pending_transaction_id ?? []),
    ...page.modified.map((txn) => txn.transaction_id),
    ...page.removed.map((txn) => txn.transaction_id),
  ]);
  const [knownBefore, existingAliases] = await Promise.all([
    deps.ingestion!.knownTxnIds(userId, lookupIds),
    deps.ingestion!.aliasesFor(userId, lookupIds),
  ]);
  const addedIds = new Set(allAdded.map((txn) => txn.transaction_id));
  const canonical = (id: string) => existingAliases.get(id) ?? id;
  const superseded = new Set<string>();
  const aliases: { plaidId: string; canonicalId: string }[] = [];

  for (const txn of allAdded) {
    const pendingId = txn.pending_transaction_id;
    if (pendingId && (knownBefore.has(pendingId) || addedIds.has(pendingId))) {
      const canonicalPending = canonical(pendingId);
      superseded.add(canonicalPending);
      aliases.push({ plaidId: txn.transaction_id, canonicalId: canonicalPending });
    }
  }

  // Creation events must precede updates even when Plaid splits related
  // records across pages in the opposite array order.
  const posts: UnsequencedEvent[] = [];
  const updates: UnsequencedEvent[] = [];
  const removals: UnsequencedEvent[] = [];
  const knownTxnIds: string[] = [];

  for (const txn of allAdded) {
    const pendingId = txn.pending_transaction_id;
    const canonicalPending = pendingId ? canonical(pendingId) : undefined;
    if (canonicalPending && superseded.has(canonicalPending)) {
      updates.push(
        makeEvent(deps, "TransactionUpdated", {
          txnId: canonicalPending,
          changes: {
            status: "posted" as const,
            postedDate: txn.date,
            ...(txn.authorized_date ? { authorizedDate: txn.authorized_date } : {}),
            ...enrich(txn),
          },
        }),
      );
      continue;
    }
    knownTxnIds.push(txn.transaction_id);
    posts.push(
      makeEvent(deps, "TransactionPosted", {
        txnId: txn.transaction_id,
        accountId: txn.account_id,
        currency: txn.iso_currency_code ?? txn.unofficial_currency_code ?? "UNKNOWN",
        status: txn.pending ? ("pending" as const) : ("posted" as const),
        postedDate: txn.date,
        ...(txn.authorized_date ? { authorizedDate: txn.authorized_date } : {}),
        categorySource: "plaid" as const,
        ...enrich(txn),
      }),
    );
  }

  for (const page of pages) {
    for (const txn of page.modified) {
      updates.push(
        makeEvent(deps, "TransactionUpdated", {
          txnId: canonical(txn.transaction_id),
          changes: {
            status: txn.pending ? ("pending" as const) : ("posted" as const),
            postedDate: txn.date,
            ...(txn.authorized_date ? { authorizedDate: txn.authorized_date } : {}),
            ...enrich(txn),
          },
        }),
      );
    }
    for (const removal of page.removed) {
      const id = canonical(removal.transaction_id);
      if (superseded.has(id)) continue;
      removals.push(
        makeEvent(deps, "TransactionRemoved", {
          txnId: id,
          reason: "removed by aggregator",
        }),
      );
    }
  }

  const events = [...posts, ...updates, ...removals];
  const violations = events.flatMap((event) => validateEventPayload(event.type, event.payload));
  if (violations.length > 0) throw new TypeError(`invalid normalized Plaid update: ${violations[0]}`);
  return { events, knownTxnIds: [...new Set(knownTxnIds)], aliases };
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
