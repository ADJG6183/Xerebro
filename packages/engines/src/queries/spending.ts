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
import { applyEvents, effectiveTransactions, emptyProjection } from "../projection/transactions";

const TRANSACTION_TYPES = new Set([
  "TransactionPosted",
  "TransactionUpdated",
  "TransactionRemoved",
  "TransactionAnnotated",
]);

export interface DateRange {
  fromDate: string; // YYYY-MM-DD inclusive
  toDate: string; // YYYY-MM-DD inclusive
}

export interface CategoryTotal {
  category: string;
  totalMinor: MinorUnits;
}

function outflowsInRange(events: readonly EventEnvelope[], range: DateRange) {
  const projection = applyEvents(
    emptyProjection(),
    events.filter((e): e is TransactionEvent => TRANSACTION_TYPES.has(e.type)),
  );
  return effectiveTransactions(projection).filter(
    (t) =>
      t.amountMinor < 0 &&
      t.postedDate !== undefined &&
      t.postedDate >= range.fromDate &&
      t.postedDate <= range.toDate,
  );
}

const UNCATEGORIZED = "Uncategorized";

/** Total spent (positive) in the range, optionally within one category. */
export function spendTotal(
  events: readonly EventEnvelope[],
  args: DateRange & { category?: string },
): MinorUnits {
  const wanted = args.category?.trim().toLowerCase();
  return outflowsInRange(events, args)
    .filter((t) => wanted === undefined || (t.effectiveCategory ?? UNCATEGORIZED).toLowerCase() === wanted)
    .reduce((sum, t) => sum - t.amountMinor, 0);
}

/** Every category with spending in the range, largest first. */
export function spendByCategory(
  events: readonly EventEnvelope[],
  range: DateRange,
): CategoryTotal[] {
  const byCategory = new Map<string, MinorUnits>();
  for (const t of outflowsInRange(events, range)) {
    const category = t.effectiveCategory ?? UNCATEGORIZED;
    byCategory.set(category, (byCategory.get(category) ?? 0) - t.amountMinor);
  }
  return [...byCategory.entries()]
    .map(([category, totalMinor]) => ({ category, totalMinor }))
    .sort((a, b) => b.totalMinor - a.totalMinor);
}

/** The N largest spending categories in the range. */
export function topCategories(
  events: readonly EventEnvelope[],
  args: DateRange & { limit?: number },
): CategoryTotal[] {
  return spendByCategory(events, args).slice(0, Math.max(1, args.limit ?? 3));
}
