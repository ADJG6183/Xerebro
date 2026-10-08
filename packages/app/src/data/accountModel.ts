/** Offline account-list model derived entirely from the local projection. */
import {
  computeFinancialState,
  assertMinorUnits,
  effectiveTransactions,
  formatMinor,
  needsOverlapReview,
  overlapKey,
  predecessorIds,
  type Account,
  type ProjectionSnapshot,
  type AccountContinuity,
} from "@xerebro/engines";
import type { ConnectedItem } from "./syncClient";

export interface AccountRowViewModel {
  history?: AccountHistoryViewModel;
  accountId: string;
  name: string;
  typeLabel: string;
  statusLabel: string;
  currency: string;
  balanceFormatted: string;
  balanceBasisLabel: string;
  spendingCapacityFormatted?: string;
  maskLabel?: string;
  ageLabel: string;
  transactionCount: number;
}

export interface AccountHistoryViewModel {
  continuity: AccountContinuity;
  candidates: { accountId: string; label: string; lastSyncedAt?: string }[];
  predecessorLabel?: string;
  transactions: OverlapViewModel[];
}

export interface OverlapViewModel {
  needsReview: boolean;
  txnId: string;
  label: string;
  statusLabel: string;
  expectedVersion: number;
  canUndo: boolean;
  candidates: { txnId: string; label: string }[];
}

export interface AccountGroupViewModel {
  connectionId: string;
  title: string;
  source: Account["source"];
  accounts: AccountRowViewModel[];
  connectionStatusLabel?: string;
  canDisconnect?: boolean;
  message?: string;
}

export interface AccountViewModel {
  groups: AccountGroupViewModel[];
  accountCount: number;
}

export function buildAccountViewModel(input: {
  snapshot: ProjectionSnapshot;
  nowIso: string;
  connections?: readonly ConnectedItem[];
}): AccountViewModel {
  const { accounts, transactions, buckets, bills } = input.snapshot;
  const state = computeFinancialState({
    accounts,
    projection: transactions,
    buckets,
    bills,
    todayLocal: input.nowIso.slice(0, 10),
  });
  const assessments = new Map(state.accountBalances.map((balance) => [balance.accountId, balance]));
  const accountNames = new Map(accounts.map((a) => [a.accountId, `${a.name}${a.mask ? ` •••• ${a.mask}` : ""}`]));
  const allTransactions = effectiveTransactions(transactions, { includeExcluded: true });
  const ledgerDeltas = new Map<string, number>();
  const matches = new Map<string, typeof allTransactions>();
  for (const txn of allTransactions) {
    if (!txn.historyExclusion) {
      const ledgerKey = JSON.stringify([txn.accountId, txn.currency]);
      ledgerDeltas.set(ledgerKey, assertMinorUnits((ledgerDeltas.get(ledgerKey) ?? 0) + txn.amountMinor));
    }
    const key = overlapKey(txn);
    if (!key || txn.historyExclusion) continue;
    const bucket = matches.get(key) ?? [];
    bucket.push(txn);
    matches.set(key, bucket);
  }
  const historyRows = new Map<string, OverlapViewModel[]>();
  const chains = new Map<string, Set<string>>();
  const usedOriginals = new Set<string>();
  for (const txn of allTransactions) {
    if (txn.historyExclusion === "confirmed_duplicate") {
      usedOriginals.add(JSON.stringify([txn.accountId, transactions.overlapReviews?.get(txn.txnId)?.originalTxnId]));
    }
  }
  for (const txn of allTransactions) {
    if (transactions.continuity?.get(txn.accountId)?.decision !== "same" || !needsOverlapReview(transactions, txn)) continue;
    let chain = chains.get(txn.accountId);
    if (!chain) { chain = predecessorIds(transactions, txn.accountId); chains.set(txn.accountId, chain); }
    const review = transactions.overlapReviews?.get(txn.txnId);
    const candidates = (matches.get(overlapKey(txn) ?? "") ?? []).filter((original) =>
      chain!.has(original.accountId) && !usedOriginals.has(JSON.stringify([txn.accountId, original.txnId])));
    const rows = historyRows.get(txn.accountId) ?? [];
    rows.push({ txnId: txn.txnId,
      needsReview: !!txn.historyExclusion && txn.historyExclusion !== "confirmed_duplicate",
      label: `${txn.effectiveMerchant} · ${formatMinor(txn.amountMinor, txn.currency)} · ${txn.postedDate ?? "Date unknown"}`,
      statusLabel: txn.historyExclusion === "confirmed_duplicate" ? "Matched — counted once" : txn.historyExclusion ? "Not counted — needs review" : "Confirmed separate — counted",
      expectedVersion: Math.max(txn.lastSequence, review?.lastSequence ?? 0),
      canUndo: !!review && review.decision !== "reopen",
      candidates: candidates.map((original) => ({ txnId: original.txnId,
        label: `${original.effectiveMerchant} · ${original.postedDate} · ${accountNames.get(original.accountId) ?? "Previous account"} · ${original.txnId.slice(-8)}` })),
    });
    historyRows.set(txn.accountId, rows);
  }
  const transactionCounts = new Map<string, number>();
  for (const txn of allTransactions) {
    transactionCounts.set(txn.accountId, (transactionCounts.get(txn.accountId) ?? 0) + 1);
  }

  const groups = new Map<string, AccountGroupViewModel>();
  const connections = new Map((input.connections ?? []).map((item) => [item.itemId, item]));
  for (const account of accounts) {
    const connectionId = account.source === "plaid" ? account.plaidItemId ?? "bank-unknown" : "manual";
    let group = groups.get(connectionId);
    if (!group) {
      group = {
        connectionId,
        title: account.source === "plaid" ? account.institutionName ?? "Connected bank" : "Manual accounts",
        source: account.source,
        accounts: [],
        ...(account.source === "plaid"
          ? connectionFields(connections.get(connectionId)?.status ?? statusFromAccount(account.status))
          : {}),
        ...(connections.get(connectionId)?.message ? { message: connections.get(connectionId)!.message } : {}),
      };
      groups.set(connectionId, group);
    }
    const assessment = assessments.get(account.accountId);
    const currentKnown = account.source === "manual" || account.balanceCurrentKnown !== false;
    const balanceMinor =
      account.source === "manual"
        ? assertMinorUnits((account.openingBalanceMinor ?? 0) + (ledgerDeltas.get(JSON.stringify([account.accountId, account.currency])) ?? 0))
        : currentKnown
          ? account.balanceCurrentMinor
          : undefined;
    group.accounts.push({
      ...(transactions.continuity?.has(account.accountId) ? { history: {
        continuity: transactions.continuity.get(account.accountId)!,
        candidates: transactions.continuity.get(account.accountId)!.candidates.map((c) => ({
          ...c, label: accountNames.get(c.accountId) ?? "Previous account",
        })),
        ...(transactions.continuity.get(account.accountId)!.predecessorId ? {
          predecessorLabel: accountNames.get(transactions.continuity.get(account.accountId)!.predecessorId!) ?? "Previous account",
        } : {}),
        transactions: historyRows.get(account.accountId) ?? [],
      } } : {}),
      accountId: account.accountId,
      name: account.name,
      typeLabel: account.type === "unknown" ? "Unknown type" : titleCase(account.type),
      statusLabel: titleCase(account.status),
      currency: account.currency,
      balanceFormatted:
        balanceMinor === undefined ? "Unavailable" : formatMinor(balanceMinor, account.currency),
      balanceBasisLabel: basisLabel(account, assessment?.basis),
      ...(assessment?.spendingCapacityMinor !== undefined
        ? {
            spendingCapacityFormatted: formatMinor(
              assessment.spendingCapacityMinor,
              account.currency,
            ),
          }
        : {}),
      ...(account.mask ? { maskLabel: `•••• ${account.mask}` } : {}),
      ageLabel: account.source === "manual" ? "Updated from your entries" : ageLabel(account.balanceAsOf, input.nowIso),
      transactionCount: transactionCounts.get(account.accountId) ?? 0,
    });
  }

  // A newly linked Item is useful information even before its first balance
  // creates account events in the local projection.
  for (const connection of connections.values()) {
    if (groups.has(connection.itemId)) continue;
    groups.set(connection.itemId, {
      connectionId: connection.itemId,
      title: "Connected bank",
      source: "plaid",
      accounts: [],
      ...connectionFields(connection.status),
      ...(connection.message ? { message: connection.message } : {}),
    });
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "plaid" ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
  for (const group of ordered) group.accounts.sort((a, b) => a.name.localeCompare(b.name));
  return { groups: ordered, accountCount: accounts.length };
}

function statusFromAccount(status: Account["status"]): ConnectedItem["status"] {
  return status === "active" ? "ready" : "disconnected";
}

function connectionFields(status: ConnectedItem["status"]): Pick<
  AccountGroupViewModel,
  "connectionStatusLabel" | "canDisconnect"
> {
  const labels: Record<ConnectedItem["status"], string> = {
    importing: "Importing account data",
    ready: "Connected",
    retry_needed: "Update delayed — retrying",
    reauthentication_needed: "Sign-in needed",
    disconnecting: "Disconnecting",
    disconnected: "Disconnected",
  };
  return {
    connectionStatusLabel: labels[status],
    canDisconnect: !["disconnecting", "disconnected"].includes(status),
  };
}

function basisLabel(account: Account, basis: string | undefined): string {
  if (account.source === "manual") return "Based on your entries";
  switch (basis) {
    case "reported_available":
      return "Available balance reported by bank";
    case "current_less_pending_outflows":
      return "Current minus pending withdrawals";
    case "excluded_currency":
      return "Excluded from USD total";
    case "excluded_type":
      return "Not assumed spendable";
    case "unknown_balance":
      return "Bank balance unavailable";
    default:
      return "Current balance reported by bank";
  }
}

function ageLabel(asOf: string, nowIso: string): string {
  const hours = Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(asOf)) / 3_600_000));
  if (!Number.isFinite(hours)) return "Update time unavailable";
  if (hours < 1) return "updated recently";
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

function titleCase(value: string): string {
  return value.replace(/(^|[_\s-])\w/g, (match) => match.toUpperCase()).replace(/_/g, " ");
}
