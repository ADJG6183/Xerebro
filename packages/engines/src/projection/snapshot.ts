/**
 * Materialized projection snapshot (ADR-003: "projections must always be
 * rebuildable from the log" — so a cache is always legal, never authoritative).
 *
 * The problem it solves: every dashboard render re-folded the ENTIRE event
 * log. That is O(all history) per render — fine at 100 events, sluggish at
 * 20,000. A snapshot carries the folded state plus the sequence it reflects,
 * so a render only folds what arrived since (O(new events)).
 *
 * The defining invariant, property-tested: advancing a snapshot event by
 * event produces state IDENTICAL to rebuilding from scratch. If that ever
 * breaks, the cache is wrong and the whole optimization is unsafe — so it is
 * the first thing the tests check.
 *
 * Accounts/buckets/bills use last-write-wins per id, so advancing is just
 * "apply the newer events on top" — no history needed.
 */
import type { EventEnvelope, TransactionEvent } from "../events";
import { foldAccounts, isAccountUpserted } from "./accounts";
import { foldBills, foldBuckets } from "./plans";
import { foldBudgetPlans, type BudgetPlan } from "./budget";
import {
  applyEvents,
  emptyProjection,
  type TransactionProjection,
} from "./transactions";
import type { Account, Bill, Bucket } from "../state/financialState";

export const TRANSACTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "AccountContinuitySet",
  "TransactionOverlapReviewed",
  "BankSyncCompleted",
  "TransactionPosted",
  "TransactionUpdated",
  "TransactionRemoved",
  "TransactionAnnotated",
]);

export interface ProjectionSnapshot {
  transactions: TransactionProjection;
  accounts: readonly Account[];
  buckets: readonly Bucket[];
  bills: readonly Bill[];
  /** Monthly category limits (projection/budget.ts) — never read by
   * computeFinancialState; a reporting/comparison concept only. */
  budgetPlans: readonly BudgetPlan[];
  /** The highest event sequence this snapshot reflects. */
  lastSequence: number;
}

export function emptySnapshot(): ProjectionSnapshot {
  return {
    transactions: emptyProjection(),
    accounts: [],
    buckets: [],
    bills: [],
    budgetPlans: [],
    lastSequence: 0,
  };
}

/**
 * Fold `events` on top of `snapshot`. Events at or below the snapshot's
 * sequence are ignored, so re-feeding overlapping pages is harmless
 * (the same idempotence the sync client relies on).
 */
export function advanceSnapshot(
  snapshot: ProjectionSnapshot,
  events: readonly EventEnvelope[],
): ProjectionSnapshot {
  const fresh = events.filter((e) => e.sequence > snapshot.lastSequence);
  if (fresh.length === 0) return snapshot;

  const transactions = applyEvents(
    snapshot.transactions,
    fresh.filter((e): e is TransactionEvent => TRANSACTION_EVENT_TYPES.has(e.type)),
  );

  return {
    transactions,
    accounts: mergeById(snapshot.accounts, foldAccounts(fresh), (a) => a.accountId),
    buckets: mergeById(snapshot.buckets, foldBuckets(fresh), (b) => b.bucketId),
    bills: mergeById(snapshot.bills, foldBills(fresh), (b) => b.billId),
    budgetPlans: mergeById(snapshot.budgetPlans, foldBudgetPlans(fresh), (p) => p.budgetPlanId),
    lastSequence: fresh.reduce((max, e) => Math.max(max, e.sequence), snapshot.lastSequence),
  };
}

/** Build a snapshot from scratch — the reference every cache must match. */
export function buildSnapshot(events: readonly EventEnvelope[]): ProjectionSnapshot {
  return advanceSnapshot(emptySnapshot(), events);
}

/** Later entries win, preserving the order existing ids first appeared. */
function mergeById<T>(existing: readonly T[], incoming: readonly T[], idOf: (t: T) => string): T[] {
  if (incoming.length === 0) return [...existing];
  const byId = new Map(existing.map((e) => [idOf(e), e]));
  for (const item of incoming) byId.set(idOf(item), item);
  return [...byId.values()];
}

/** True when an event could change accounts/buckets/bills/budgetPlans/transactions. */
export function affectsProjection(event: EventEnvelope): boolean {
  return (
    TRANSACTION_EVENT_TYPES.has(event.type) ||
    isAccountUpserted(event) ||
    event.type === "BucketUpserted" ||
    event.type === "BillUpserted" ||
    event.type === "BudgetPlanUpserted"
  );
}
