/**
 * Dashboard view-model: device log → the numbers and labels the home screen
 * renders. Pure — clock and today are injected, so tests are deterministic
 * and the UI layer stays a dumb painter.
 *
 * Invariant made visible here: every displayed number carries a knowable data
 * age (docs/SystemInvariants.md) — the view-model computes the label, the UI
 * just shows it.
 */
import {
  buildSnapshot,
  computeFinancialState,
  effectiveTransactions,
  formatMinor,
  type EffectiveTransaction,
  type EventEnvelope,
  type ProjectionSnapshot,
} from "@xerebro/engines";

export interface DashboardTxn {
  txnId: string;
  accountId: string;
  merchant: string;
  /** Aggregator merchant logo; absent for manual entries and unresolved
   * merchants — the UI falls back to a category icon (ui/bits.tsx). */
  logoUrl?: string;
  category?: string;
  amountFormatted: string;
  isInflow: boolean;
  date?: string;
  pending: boolean;
  currency: string;
  amountMinor: number;
  historyExcluded: boolean;
}

/**
 * The one place an EffectiveTransaction becomes a display row. Shared by the
 * dashboard (below) and the Spending screen (spendingModel.ts) so the two
 * never show the same transaction decorated two different ways.
 */
export function toDashboardTxn(t: EffectiveTransaction): DashboardTxn {
  return {
    txnId: t.txnId,
    accountId: t.accountId,
    merchant: `${t.effectiveMerchant}${t.historyExclusion === "confirmed_duplicate" ? " · Matched duplicate" : t.historyExclusion ? " · Needs review" : ""}`,
    historyExcluded: !!t.historyExclusion,
    ...(t.merchantLogoUrl !== undefined ? { logoUrl: t.merchantLogoUrl } : {}),
    ...(t.effectiveCategory !== undefined ? { category: t.effectiveCategory } : {}),
    amountFormatted: `${t.amountMinor > 0 ? "+" : ""}${formatMinor(t.amountMinor, t.currency)}`,
    isInflow: t.amountMinor > 0,
    ...(t.postedDate !== undefined ? { date: t.postedDate } : {}),
    pending: t.status === "pending",
    currency: t.currency,
    amountMinor: t.amountMinor,
  };
}

export interface TxnGroup {
  /** "Today", "Yesterday", or a date like "May 12, 2026". */
  label: string;
  items: DashboardTxn[];
}

export interface DashboardViewModel {
  hasAccounts: boolean;
  availableCashFormatted: string;
  bucketAllocatedFormatted: string;
  upcomingObligationsFormatted: string;
  /** Sum of inflows / outflows whose postedDate falls in the current month. */
  incomeThisMonthFormatted: string;
  expensesThisMonthFormatted: string;
  dataAgeLabel: string;
  /** Read-only totals may render with uncertainty, but never silently. */
  balanceWarning?: string;
  recentTransactions: DashboardTxn[];
  /** All non-removed transactions, newest first, grouped by day (mockup: Transactions screen). */
  transactionGroups: TxnGroup[];
  lastSequence: number;
}

export function buildDashboardViewModel(input: {
  /** Folded state. Callers pass a cached snapshot (projectionCache) so a
   * render costs O(new events), not O(all history); `events` is accepted for
   * tests and one-off builds. */
  snapshot?: ProjectionSnapshot;
  events?: readonly EventEnvelope[];
  /** YYYY-MM-DD in the user's timezone — injected, never read from a clock here. */
  todayLocal: string;
  /** ISO UTC "now" — injected for the data-age label. */
  nowIso: string;
}): DashboardViewModel {
  const { todayLocal, nowIso } = input;

  // Everything derives from the one event log: accounts, buckets, and bills
  // all fold from it, so the dashboard and the decision engine read exactly
  // the same money picture (docs/adr/ADR-003-events.md).
  const snap = input.snapshot ?? buildSnapshot(input.events ?? []);
  const { accounts, buckets, bills, transactions: projection } = snap;

  const state = computeFinancialState({ accounts, projection, buckets, bills, todayLocal });

  const sorted = effectiveTransactions(projection, { includeExcluded: true })
    .sort((a, b) => (b.postedDate ?? "").localeCompare(a.postedDate ?? "") || b.lastSequence - a.lastSequence)
    .map(toDashboardTxn);

  const month = todayLocal.slice(0, 7);
  const inMonth = sorted.filter((t) => !t.historyExcluded && t.currency === "USD" && t.date?.startsWith(month));
  const incomeMinor = inMonth.filter((t) => t.amountMinor > 0).reduce((a, t) => a + t.amountMinor, 0);
  const expensesMinor = inMonth.filter((t) => t.amountMinor < 0).reduce((a, t) => a - t.amountMinor, 0);

  const groups: TxnGroup[] = [];
  for (const txn of sorted) {
    const label = dayLabel(txn.date, todayLocal);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(txn);
    else groups.push({ label, items: [txn] });
  }
  const warning = balanceWarning(state);

  return {
    hasAccounts: accounts.length > 0,
    availableCashFormatted: formatMinor(state.availableCashMinor),
    bucketAllocatedFormatted: formatMinor(state.bucketAllocatedMinor),
    upcomingObligationsFormatted: formatMinor(state.upcomingObligationsMinor),
    incomeThisMonthFormatted: formatMinor(incomeMinor),
    expensesThisMonthFormatted: formatMinor(expensesMinor),
    dataAgeLabel: state.accountBalances.some((balance) => balance.source === "plaid")
      ? dataAgeLabel(state.dataAsOf, nowIso, true)
      : accounts.length > 0
        ? "based on your manual entries"
        : "no accounts yet",
    ...(warning ? { balanceWarning: warning } : {}),
    recentTransactions: groups.flatMap((g) => g.items).slice(0, 5),
    transactionGroups: groups,
    lastSequence: state.lastSequence,
  };
}

function balanceWarning(state: ReturnType<typeof computeFinancialState>): string | undefined {
  if (state.historyWarnings.length) return state.historyWarnings[0];
  if (state.unknownBalanceAccountIds.length > 0) return "Some bank balances are unavailable";
  if (state.unsupportedCurrencyAccountIds.length > 0) return "Non-USD accounts are excluded";
  if (state.unknownTypeAccountIds.length > 0) return "Unknown account types are excluded";
  if (state.unsupportedCurrencyTransactionIds.length > 0) {
    return "Non-USD transactions are excluded from USD totals";
  }
  if (state.overallocatedMinor > 0) return "Your bucket allocations exceed known cash";
  if (state.accountBalances.some((balance) => balance.basis === "current_less_pending_outflows")) {
    return "Estimated from current balance minus pending withdrawals";
  }
  if (state.reconciliationStatus === "unknown") return "Bank history is not yet reconciled";
  if (state.reconciliationStatus === "failed") return "Bank balance reconciliation failed";
  return undefined;
}

export function dayLabel(date: string | undefined, todayLocal: string): string {
  if (!date) return "Pending";
  if (date === todayLocal) return "Today";
  const yesterday = new Date(`${todayLocal}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (date === yesterday.toISOString().slice(0, 10)) return "Yesterday";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Read-only-class freshness labels (docs/verificationEngine.md). */
export function dataAgeLabel(dataAsOf: string, nowIso: string, hasAccounts: boolean): string {
  if (!hasAccounts) return "no accounts yet";
  const ageMs = Date.parse(nowIso) - Date.parse(dataAsOf);
  const ageHours = ageMs / 3_600_000;
  if (ageHours < 1) return "up to date";
  if (ageHours < 24) return `as of ${Math.floor(ageHours)}h ago`;
  if (ageHours < 72) return "as of yesterday or earlier";
  return "stale — reconnect your bank";
}
