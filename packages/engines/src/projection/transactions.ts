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
import type { TransactionEvent, TransactionPostedPayload } from "../events";
import { validateEventPayload } from "../validation";
import { historyExclusions, type AccountContinuity, type OverlapReview, type HistoryExclusion } from "./continuity";

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
  continuity?: ReadonlyMap<string, AccountContinuity>;
  overlapReviews?: ReadonlyMap<string, OverlapReview>;
  syncCheckpoints?: ReadonlyMap<string, string>;
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
  return foldEvent(projection, event, true);
}

/** In a batch these collections are privately owned, so copy only once. */
function foldEvent(projection: TransactionProjection, event: TransactionEvent, copy: boolean): TransactionProjection {
  if (projection.appliedEventIds.has(event.eventId)) return projection;

  const transactions = copy ? new Map(projection.transactions) : projection.transactions as Map<string, TransactionRow>;
  const annotations = copy ? new Map(projection.annotations) : projection.annotations as Map<string, TransactionAnnotation>;
  const appliedEventIds = (copy ? new Set(projection.appliedEventIds) : projection.appliedEventIds as Set<string>).add(event.eventId);
  const warnings = copy ? [...projection.warnings] : projection.warnings as string[];
  const lastSequence = Math.max(projection.lastSequence, event.sequence);
  const continuity = copy ? new Map(projection.continuity) : projection.continuity as Map<string, AccountContinuity>;
  const overlapReviews = copy ? new Map(projection.overlapReviews) : projection.overlapReviews as Map<string, OverlapReview>;
  const syncCheckpoints = copy ? new Map(projection.syncCheckpoints) : projection.syncCheckpoints as Map<string, string>;

  // Poison-pill defense (validation.ts): the log is append-only, so a
  // malformed event that got past the door must NEVER brick the fold —
  // skip it, record why, keep reading. Throwing here would make one bad
  // page crash every reader forever.
  const invalid = validateEventPayload(event.type, event.payload);
  if (invalid.length > 0) {
    warnings.push(`skipped malformed ${event.eventId} (seq ${event.sequence}): ${invalid[0]}`);
    return { ...projection, transactions, annotations, appliedEventIds, lastSequence, warnings };
  }

  switch (event.type) {
    case "AccountContinuitySet":
      continuity.set(event.payload.accountId, { ...event.payload, lastSequence: event.sequence });
      break;
    case "TransactionOverlapReviewed":
      overlapReviews.set(event.payload.txnId, { ...event.payload, lastSequence: event.sequence });
      break;
    case "BankSyncCompleted": {
      const { itemId, completedAt } = event.payload;
      if (completedAt > (syncCheckpoints.get(itemId) ?? "")) syncCheckpoints.set(itemId, completedAt);
      break;
    }
    case "TransactionPosted": {
      const p = event.payload;
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

  return { transactions, annotations, appliedEventIds, lastSequence, warnings,
    continuity, overlapReviews, syncCheckpoints };
}

export function applyEvents(
  projection: TransactionProjection,
  events: readonly TransactionEvent[],
): TransactionProjection {
  if (!events.length) return projection;
  const owned: TransactionProjection = { ...projection,
    transactions: new Map(projection.transactions), annotations: new Map(projection.annotations),
    appliedEventIds: new Set(projection.appliedEventIds), warnings: [...projection.warnings],
    continuity: new Map(projection.continuity), overlapReviews: new Map(projection.overlapReviews),
    syncCheckpoints: new Map(projection.syncCheckpoints),
  };
  return events.reduce((current, event) => foldEvent(current, event, false), owned);
}

/** A transaction as engines must read it: overlay applied, source fields intact. */
export interface EffectiveTransaction extends TransactionRow {
  historyExclusion?: HistoryExclusion;
  effectiveCategory?: string;
  effectiveMerchant: string;
}

export function effectiveTransactions(
  projection: TransactionProjection,
  { includeRemoved = false, includeExcluded = false } = {},
): EffectiveTransaction[] {
  const out: EffectiveTransaction[] = [];
  const exclusions = historyExclusions(projection);
  for (const row of projection.transactions.values()) {
    if (row.removed && !includeRemoved) continue;
    const historyExclusion = exclusions.get(row.txnId);
    if (historyExclusion && !includeExcluded) continue;
    const a = projection.annotations.get(row.txnId);
    out.push({
      ...row,
      ...(historyExclusion ? { historyExclusion } : {}),
      ...(a?.categoryOverride ?? row.category
        ? { effectiveCategory: a?.categoryOverride ?? row.category }
        : {}),
      // Display precedence: the user's own rename, then the aggregator's
      // cleaned name ("Uber"), then the bank's raw description
      // ("Uber 063015 SF**POOL**"). The raw value stays on the row as the
      // source fact — this is display only.
      effectiveMerchant: a?.renamedMerchant ?? row.merchantName ?? row.merchantRaw,
    });
  }
  return out;
}
