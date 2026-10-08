/**
 * One transaction's full detail (docs/rocketMoneyMvpSpec.md §6 Spending):
 * amount/currency, account, dates, status, effective category, notes, and
 * any history-exclusion reason. Separate from DashboardTxn (dashboardModel.ts)
 * on purpose — the list view stays light for scrolling, this carries the
 * extra fields only the detail screen needs.
 */
import {
  effectiveTransactions,
  formatMinor,
  type HistoryExclusion,
  type ProjectionSnapshot,
} from "@xerebro/engines";

export interface TransactionDetail {
  txnId: string;
  amountFormatted: string;
  isInflow: boolean;
  currency: string;
  accountId: string;
  accountName: string;
  status: "pending" | "posted";
  postedDate?: string;
  authorizedDate?: string;
  merchant: string;
  /** The raw bank description — shown alongside the cleaned/renamed display
   * name; corrections never hide or edit this (spec §6: "Do not let users
   * edit imported source amounts or hide unexplained records"). */
  merchantRaw: string;
  category?: string;
  note?: string;
  historyExclusionReason?: string;
  removed: boolean;
  removedReason?: string;
}

/** Null when the id isn't found — removed/excluded transactions are still
 * findable here (includeRemoved/includeExcluded), since the spec requires
 * excluded and confirmed-duplicate records to remain accessible in history. */
export function buildTransactionDetail(
  snapshot: ProjectionSnapshot,
  txnId: string,
): TransactionDetail | null {
  const t = effectiveTransactions(snapshot.transactions, {
    includeExcluded: true,
    includeRemoved: true,
  }).find((x) => x.txnId === txnId);
  if (!t) return null;

  const account = snapshot.accounts.find((a) => a.accountId === t.accountId);
  const note = snapshot.transactions.annotations.get(txnId)?.note;

  return {
    txnId: t.txnId,
    amountFormatted: `${t.amountMinor > 0 ? "+" : ""}${formatMinor(t.amountMinor, t.currency)}`,
    isInflow: t.amountMinor > 0,
    currency: t.currency,
    accountId: t.accountId,
    accountName: account?.name ?? "Unknown account",
    status: t.status,
    ...(t.postedDate !== undefined ? { postedDate: t.postedDate } : {}),
    ...(t.authorizedDate !== undefined ? { authorizedDate: t.authorizedDate } : {}),
    merchant: t.effectiveMerchant,
    merchantRaw: t.merchantRaw,
    ...(t.effectiveCategory !== undefined ? { category: t.effectiveCategory } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(t.historyExclusion !== undefined
      ? { historyExclusionReason: exclusionReason(t.historyExclusion) }
      : {}),
    removed: t.removed,
    ...(t.removedReason !== undefined ? { removedReason: t.removedReason } : {}),
  };
}

function exclusionReason(reason: HistoryExclusion): string {
  switch (reason) {
    case "account_review":
      return "Excluded until you confirm whether this is the same account as a previous connection.";
    case "overlap_review":
      return "Excluded until you confirm whether this overlaps with earlier imported history.";
    case "confirmed_duplicate":
      return "Matched as a duplicate of another transaction — kept here for the record, not counted twice.";
  }
}
