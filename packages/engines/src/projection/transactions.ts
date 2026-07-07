/**
 * Reference fold: events → transaction projection (docs/adr/ADR-003-events.md).
 *
 * This in-memory fold is the SPEC-AS-CODE. The device SQLite fold and the
 * server Postgres fold must produce state equal to this one for the same
 * event list — that equivalence is what "projections must always be
 * rebuildable from the log" means in practice, and it is property-tested.
 *
 * Rules enforced here:
 *  - append-only semantics: removal is a tombstone, never a delete
 *  - duplicate eventIds are no-ops (defense in depth under ingestion idempotency)
 *  - annotations are an overlay keyed by canonical txnId and survive updates
 *  - updates/annotations for unknown txnIds are recorded as warnings, not errors
 */
import type { TransactionEvent, TransactionPostedPayload } from "../events.js";
import { assertMinorUnits } from "../money.js";

export interface TransactionRow extends TransactionPostedPayload {
  removed: boolean;
  removedReason?: string;
  lastSequence: number;
}

export interface TransactionAnnotation {
  txnId: string;
  categoryOverride?: string;
  note?: string;
  renamedMerchant?: string;
  lastSequence: number;
}

export interface TransactionProjection {
  transactions: ReadonlyMap<string, TransactionRow>;
  annotations: ReadonlyMap<string, TransactionAnnotation>;
  appliedEventIds: ReadonlySet<string>;
  lastSequence: number;
  warnings: readonly string[];
}

export function emptyProjection(): TransactionProjection {
  return {
    transactions: new Map(),
    annotations: new Map(),
    appliedEventIds: new Set(),
    lastSequence: 0,
    warnings: [],
  };
}

export function applyEvent(
  projection: TransactionProjection,
  event: TransactionEvent,
): TransactionProjection {
  if (projection.appliedEventIds.has(event.eventId)) return projection;

  const transactions = new Map(projection.transactions);
  const annotations = new Map(projection.annotations);
  const appliedEventIds = new Set(projection.appliedEventIds).add(event.eventId);
  const warnings = [...projection.warnings];
  const lastSequence = Math.max(projection.lastSequence, event.sequence);

  switch (event.type) {
    case "TransactionPosted": {
      const p = event.payload;
      assertMinorUnits(p.amountMinor, `txn ${p.txnId} amount`);
      if (transactions.has(p.txnId)) {
        warnings.push(`TransactionPosted for existing txnId ${p.txnId} ignored (seq ${event.sequence})`);
        break;
      }
      transactions.set(p.txnId, { ...p, removed: false, lastSequence: event.sequence });
      break;
    }
    case "TransactionUpdated": {
      const { txnId, changes } = event.payload;
      const row = transactions.get(txnId);
      if (!row) {
        warnings.push(`TransactionUpdated for unknown txnId ${txnId} (seq ${event.sequence})`);
        break;
      }
      if (changes.amountMinor !== undefined) assertMinorUnits(changes.amountMinor, `txn ${txnId} amount`);
      transactions.set(txnId, { ...row, ...changes, lastSequence: event.sequence });
      break;
    }
    case "TransactionRemoved": {
      const { txnId, reason } = event.payload;
      const row = transactions.get(txnId);
      if (!row) {
        warnings.push(`TransactionRemoved for unknown txnId ${txnId} (seq ${event.sequence})`);
        break;
      }
      transactions.set(txnId, {
        ...row,
        removed: true,
        ...(reason !== undefined ? { removedReason: reason } : {}),
        lastSequence: event.sequence,
      });
      break;
    }
    case "TransactionAnnotated": {
      const { txnId, ...changes } = event.payload;
      if (!transactions.has(txnId)) {
        warnings.push(`TransactionAnnotated for unknown txnId ${txnId} (seq ${event.sequence})`);
        break;
      }
      const existing = annotations.get(txnId);
      annotations.set(txnId, { txnId, ...existing, ...changes, lastSequence: event.sequence });
      break;
    }
  }

  return { transactions, annotations, appliedEventIds, lastSequence, warnings };
}

export function applyEvents(
  projection: TransactionProjection,
  events: readonly TransactionEvent[],
): TransactionProjection {
  return events.reduce(applyEvent, projection);
}

/** A transaction as engines must read it: overlay applied, source fields intact. */
export interface EffectiveTransaction extends TransactionRow {
  effectiveCategory?: string;
  effectiveMerchant: string;
}

export function effectiveTransactions(
  projection: TransactionProjection,
  { includeRemoved = false } = {},
): EffectiveTransaction[] {
  const out: EffectiveTransaction[] = [];
  for (const row of projection.transactions.values()) {
    if (row.removed && !includeRemoved) continue;
    const a = projection.annotations.get(row.txnId);
    out.push({
      ...row,
      ...(a?.categoryOverride ?? row.category
        ? { effectiveCategory: a?.categoryOverride ?? row.category }
        : {}),
      effectiveMerchant: a?.renamedMerchant ?? row.merchantRaw,
    });
  }
  return out;
}
