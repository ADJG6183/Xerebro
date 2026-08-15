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
import type { MinorUnits } from "@xerebro/engines";
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
          changes: {
            status: "posted" as const,
            amountMinor: toMinorUnits(txn.amount),
            postedDate: txn.date,
            merchantRaw: txn.name,
            ...(txn.personal_finance_category?.primary
              ? { category: txn.personal_finance_category.primary }
              : {}),
          },
        }),
      );
    } else {
      await deps.registry.add(userId, txn.transaction_id);
      events.push(
        makeEvent(deps, "TransactionPosted", {
          txnId: txn.transaction_id,
          accountId: txn.account_id,
          amountMinor: toMinorUnits(txn.amount),
          currency: txn.iso_currency_code ?? "USD",
          status: txn.pending ? ("pending" as const) : ("posted" as const),
          postedDate: txn.date,
          ...(txn.authorized_date ? { authorizedDate: txn.authorized_date } : {}),
          merchantRaw: txn.name,
          ...(txn.personal_finance_category?.primary
            ? { category: txn.personal_finance_category.primary }
            : {}),
          categorySource: "plaid" as const,
        }),
      );
    }
  }

  for (const txn of page.modified) {
    const canonical = await canonicalId(deps, userId, txn.transaction_id);
    events.push(
      makeEvent(deps, "TransactionUpdated", {
        txnId: canonical,
        changes: {
          amountMinor: toMinorUnits(txn.amount),
          merchantRaw: txn.name,
          ...(txn.personal_finance_category?.primary
            ? { category: txn.personal_finance_category.primary }
            : {}),
        },
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
