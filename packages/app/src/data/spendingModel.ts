/**
 * Spending screen view-model (docs/rocketMoneyMvpSpec.md §6): month total,
 * category breakdown, and a filtered/searchable transaction list — built
 * from the SAME already-folded projection the dashboard reads, using the
 * engines' projection-based queries (spendTotalFromProjection /
 * spendByCategoryFromProjection) so a render never re-folds raw events.
 *
 * Reporting policy (approved, rocketMoneyTracker.md stage 1 #2): settled
 * spend counts by posted_date; this file follows the same convention the
 * engine queries already use (effectiveTransactions' postedDate).
 *
 * Month scoping vs. search: the category/total always reflect the selected
 * month. The transaction LIST is month-scoped too, UNLESS a search term is
 * present — the spec requires search to reach "complete eligible local
 * history, not only a recent dashboard subset." A search therefore scans
 * every transaction, capped at `limit` with `resultCount` telling the UI how
 * many more exist, instead of formatting/rendering an unbounded result set.
 */
import {
  effectiveTransactions,
  formatMinor,
  monthDateRange,
  pendingSpendTotalFromProjection,
  spendByCategoryFromProjection,
  spendTotalFromProjection,
  type ProjectionSnapshot,
} from "@xerebro/engines";
import { dayLabel, toDashboardTxn, type TxnGroup } from "./dashboardModel";

export interface SpendingFilters {
  accountId?: string;
  category?: string;
  direction?: "all" | "income" | "expense";
  status?: "all" | "pending" | "posted";
  /** Merchant/description substring, case-insensitive. */
  search?: string;
}

export interface SpendingCategoryRow {
  category: string;
  totalFormatted: string;
  totalMinor: number;
}

export interface SpendingViewModel {
  month: string;
  totalSpentFormatted: string;
  /** Committed/pending outflows this month — shown separately, never
   * folded into totalSpentFormatted (approved reporting policy). */
  pendingSpentFormatted: string;
  pendingSpentMinor: number;
  categories: SpendingCategoryRow[];
  groups: TxnGroup[];
  /** How many transactions match the current filters in total. */
  resultCount: number;
  /** How many of those are actually in `groups` (bounded by `limit`). */
  shownCount: number;
  /** True when the list scope is "all history" (search active) rather than
   * just the selected month. */
  searchingAllHistory: boolean;
}

const UNCATEGORIZED = "Uncategorized";
const DEFAULT_LIMIT = 100;

export function buildSpendingViewModel(
  snapshot: ProjectionSnapshot,
  args: {
    /** Local YYYY-MM. */
    month: string;
    todayLocal: string;
    filters?: SpendingFilters;
    /** How many rows to materialize into `groups`. Default 100 — the UI can
     * ask for more (e.g. a "show more" action) without changing the query. */
    limit?: number;
  },
): SpendingViewModel {
  const projection = snapshot.transactions;
  const filters = args.filters ?? {};
  const needle = filters.search?.trim().toLowerCase();
  const searchingAllHistory = !!needle;

  const range = monthDateRange(args.month);
  const categoryArg = filters.category ? { category: filters.category } : {};
  const totalSpentMinor = spendTotalFromProjection(projection, { ...range, ...categoryArg });
  const pendingSpentMinor = pendingSpendTotalFromProjection(projection, { ...range, ...categoryArg });
  const categories: SpendingCategoryRow[] = spendByCategoryFromProjection(projection, range).map((c) => ({
    category: c.category,
    totalMinor: c.totalMinor,
    totalFormatted: formatMinor(c.totalMinor),
  }));

  let rows = effectiveTransactions(projection, { includeExcluded: true }).map(toDashboardTxn);
  if (!searchingAllHistory) rows = rows.filter((t) => t.date !== undefined && t.date.startsWith(args.month));
  if (filters.accountId) rows = rows.filter((t) => t.accountId === filters.accountId);
  if (filters.category) {
    // Match spendTotalFromProjection's own case-insensitive comparison
    // exactly — otherwise the total and the list it's supposed to explain
    // can disagree on which transactions count.
    const wantedCategory = filters.category.toLowerCase();
    rows = rows.filter((t) => (t.category ?? UNCATEGORIZED).toLowerCase() === wantedCategory);
  }
  if (filters.direction === "income") rows = rows.filter((t) => t.isInflow);
  if (filters.direction === "expense") rows = rows.filter((t) => !t.isInflow);
  if (filters.status === "pending") rows = rows.filter((t) => t.pending);
  if (filters.status === "posted") rows = rows.filter((t) => !t.pending);
  if (needle) rows = rows.filter((t) => t.merchant.toLowerCase().includes(needle));

  rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const resultCount = rows.length;
  const page = rows.slice(0, args.limit ?? DEFAULT_LIMIT);

  const groups: TxnGroup[] = [];
  for (const txn of page) {
    const label = dayLabel(txn.date, args.todayLocal);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(txn);
    else groups.push({ label, items: [txn] });
  }

  return {
    month: args.month,
    totalSpentFormatted: formatMinor(totalSpentMinor),
    pendingSpentFormatted: formatMinor(pendingSpentMinor),
    pendingSpentMinor,
    categories,
    groups,
    resultCount,
    shownCount: page.length,
    searchingAllHistory,
  };
}
