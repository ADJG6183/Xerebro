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
  applyEvents,
  computeFinancialState,
  effectiveTransactions,
  emptyProjection,
  foldAccounts,
  formatMinor,
  type Bill,
  type Bucket,
  type EventEnvelope,
  type TransactionEvent,
} from "@xerebro/engines";

const TRANSACTION_TYPES = new Set([
  "TransactionPosted",
  "TransactionUpdated",
  "TransactionRemoved",
  "TransactionAnnotated",
]);

export interface DashboardTxn {
  txnId: string;
  merchant: string;
  category?: string;
  amountFormatted: string;
  isInflow: boolean;
  date?: string;
  pending: boolean;
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
  recentTransactions: DashboardTxn[];
  /** All non-removed transactions, newest first, grouped by day (mockup: Transactions screen). */
  transactionGroups: TxnGroup[];
  lastSequence: number;
}

export function buildDashboardViewModel(input: {
  events: readonly EventEnvelope[];
  buckets?: readonly Bucket[];
  bills?: readonly Bill[];
  /** YYYY-MM-DD in the user's timezone — injected, never read from a clock here. */
  todayLocal: string;
  /** ISO UTC "now" — injected for the data-age label. */
  nowIso: string;
}): DashboardViewModel {
  const { events, buckets = [], bills = [], todayLocal, nowIso } = input;

  const accounts = foldAccounts(events);
  const projection = applyEvents(
    emptyProjection(),
    events.filter((e): e is TransactionEvent => TRANSACTION_TYPES.has(e.type)),
  );

  const state = computeFinancialState({ accounts, projection, buckets, bills, todayLocal });

  const sorted = effectiveTransactions(projection)
    .sort((a, b) => (b.postedDate ?? "").localeCompare(a.postedDate ?? "") || b.lastSequence - a.lastSequence)
    .map((t) => ({
      txnId: t.txnId,
      merchant: t.effectiveMerchant,
      ...(t.effectiveCategory !== undefined ? { category: t.effectiveCategory } : {}),
      amountFormatted: `${t.amountMinor > 0 ? "+" : ""}${formatMinor(t.amountMinor)}`,
      isInflow: t.amountMinor > 0,
      ...(t.postedDate !== undefined ? { date: t.postedDate } : {}),
      pending: t.status === "pending",
      amountMinor: t.amountMinor,
    }));

  const month = todayLocal.slice(0, 7);
  const inMonth = sorted.filter((t) => t.date?.startsWith(month));
  const incomeMinor = inMonth.filter((t) => t.amountMinor > 0).reduce((a, t) => a + t.amountMinor, 0);
  const expensesMinor = inMonth.filter((t) => t.amountMinor < 0).reduce((a, t) => a - t.amountMinor, 0);

  const groups: TxnGroup[] = [];
  for (const { amountMinor: _drop, ...txn } of sorted) {
    const label = dayLabel(txn.date, todayLocal);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(txn);
    else groups.push({ label, items: [txn] });
  }

  return {
    hasAccounts: accounts.length > 0,
    availableCashFormatted: formatMinor(state.availableCashMinor),
    bucketAllocatedFormatted: formatMinor(state.bucketAllocatedMinor),
    upcomingObligationsFormatted: formatMinor(state.upcomingObligationsMinor),
    incomeThisMonthFormatted: formatMinor(incomeMinor),
    expensesThisMonthFormatted: formatMinor(expensesMinor),
    dataAgeLabel: dataAgeLabel(state.dataAsOf, nowIso, accounts.length > 0),
    recentTransactions: groups.flatMap((g) => g.items).slice(0, 5),
    transactionGroups: groups,
    lastSequence: state.lastSequence,
  };
}

function dayLabel(date: string | undefined, todayLocal: string): string {
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
