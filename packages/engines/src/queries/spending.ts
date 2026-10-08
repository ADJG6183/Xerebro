/**
 * Spending queries — deterministic aggregates the copilot phrases but never
 * computes itself (docs/copilotArchitecture.md). Pure folds over the event
 * log; money stays integer minor units throughout.
 *
 * "Spending" = outflows (negative amounts), returned as positive totals.
 * Ranges are inclusive local dates on postedDate; a transaction with no
 * postedDate (rare) is excluded from date-scoped queries.
 */
import type { EventEnvelope, TransactionEvent } from "../events";
import type { MinorUnits } from "../money";
import {
  applyEvents,
  effectiveTransactions,
  emptyProjection,
  type TransactionProjection,
} from "../projection/transactions";
import { TRANSACTION_EVENT_TYPES } from "../projection/snapshot";

export interface DateRange {
  fromDate: string; // YYYY-MM-DD inclusive
  toDate: string; // YYYY-MM-DD inclusive
}

/** The inclusive local-date range for a YYYY-MM month string. Noon-UTC
 * anchored purely as a calendar calculator (never compared to a real
 * instant) so month-end rollover is exact without DST-adjacent surprises —
 * same device-local-date convention as the rest of DataModel.md. */
export function monthDateRange(month: string): DateRange {
  const d = new Date(`${month}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0); // day 0 of next month = last day of this one
  return { fromDate: `${month}-01`, toDate: d.toISOString().slice(0, 10) };
}

export interface CategoryTotal {
  category: string;
  totalMinor: MinorUnits;
}

function projectionOfEvents(events: readonly EventEnvelope[]): TransactionProjection {
  return applyEvents(
    emptyProjection(),
    events.filter((e): e is TransactionEvent => TRANSACTION_EVENT_TYPES.has(e.type)),
  );
}

/**
 * Settled outflows: posted only, grouped by postedDate. This is "spending"
 * for every total/category figure below — a still-pending charge is not yet
 * a completed expense (approved reporting policy, rocketMoneyTracker.md
 * stage 1 #2). Plaid sets postedDate on PENDING transactions too (its
 * `date` field, regardless of status) — without the explicit status check
 * here, a pending charge would silently count as settled spend.
 */
function outflowsInRange(projection: TransactionProjection, range: DateRange) {
  return effectiveTransactions(projection).filter(
    (t) =>
      t.status === "posted" &&
      t.amountMinor < 0 &&
      t.currency === "USD" &&
      t.postedDate !== undefined &&
      t.postedDate >= range.fromDate &&
      t.postedDate <= range.toDate,
  );
}

/**
 * Pending outflows: shown separately from settled spend, never folded into
 * it. Grouped by authorizedDate when present, falling back to postedDate —
 * the approved policy's pending-attribution rule — since a pending charge's
 * postedDate is provisional and gets rewritten when it actually posts.
 */
function pendingOutflowsInRange(projection: TransactionProjection, range: DateRange) {
  return effectiveTransactions(projection).filter((t) => {
    if (t.status !== "pending" || t.amountMinor >= 0 || t.currency !== "USD") return false;
    const attributedDate = t.authorizedDate ?? t.postedDate;
    return attributedDate !== undefined && attributedDate >= range.fromDate && attributedDate <= range.toDate;
  });
}

const UNCATEGORIZED = "Uncategorized";

/**
 * Total spent (positive) in the range, optionally within one category.
 * Takes an already-folded projection — callers holding one (the device's
 * projectionCache, the server's per-request fold) must not re-fold raw
 * events just to run a report. `spendTotal` below is the events-based
 * convenience wrapper for callers without one (e.g. the copilot tool
 * registry, which only has a raw event slice to hand).
 */
export function spendTotalFromProjection(
  projection: TransactionProjection,
  args: DateRange & { category?: string },
): MinorUnits {
  const wanted = args.category?.trim().toLowerCase();
  return outflowsInRange(projection, args)
    .filter((t) => wanted === undefined || (t.effectiveCategory ?? UNCATEGORIZED).toLowerCase() === wanted)
    .reduce((sum, t) => sum - t.amountMinor, 0);
}

export function spendTotal(
  events: readonly EventEnvelope[],
  args: DateRange & { category?: string },
): MinorUnits {
  return spendTotalFromProjection(projectionOfEvents(events), args);
}

/** Every category with spending in the range, largest first. Same
 * projection-vs-events split as spendTotal/spendTotalFromProjection. */
export function spendByCategoryFromProjection(
  projection: TransactionProjection,
  range: DateRange,
): CategoryTotal[] {
  const byCategory = new Map<string, MinorUnits>();
  for (const t of outflowsInRange(projection, range)) {
    const category = t.effectiveCategory ?? UNCATEGORIZED;
    byCategory.set(category, (byCategory.get(category) ?? 0) - t.amountMinor);
  }
  return [...byCategory.entries()]
    .map(([category, totalMinor]) => ({ category, totalMinor }))
    .sort((a, b) => b.totalMinor - a.totalMinor);
}

export function spendByCategory(
  events: readonly EventEnvelope[],
  range: DateRange,
): CategoryTotal[] {
  return spendByCategoryFromProjection(projectionOfEvents(events), range);
}

/** The N largest spending categories in the range. */
export function topCategories(
  events: readonly EventEnvelope[],
  args: DateRange & { limit?: number },
): CategoryTotal[] {
  return spendByCategory(events, args).slice(0, Math.max(1, args.limit ?? 3));
}

/**
 * Committed/pending spend: shown alongside settled spend, never summed into
 * it (approved reporting policy). Same category-filter and projection/events
 * split as spendTotal.
 */
export function pendingSpendTotalFromProjection(
  projection: TransactionProjection,
  args: DateRange & { category?: string },
): MinorUnits {
  const wanted = args.category?.trim().toLowerCase();
  return pendingOutflowsInRange(projection, args)
    .filter((t) => wanted === undefined || (t.effectiveCategory ?? UNCATEGORIZED).toLowerCase() === wanted)
    .reduce((sum, t) => sum - t.amountMinor, 0);
}

export function pendingSpendTotal(
  events: readonly EventEnvelope[],
  args: DateRange & { category?: string },
): MinorUnits {
  return pendingSpendTotalFromProjection(projectionOfEvents(events), args);
}
