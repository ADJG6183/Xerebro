/**
 * Financial State Engine v0 (docs/FinancialStateEngine.md).
 * Pure functions over projections. No recommendations, no user I/O, no network.
 *
 * Balance modes — a subtlety the docs imply but code must make explicit:
 *  - "plaid" accounts: the bank's available balance ALREADY nets pending
 *    transactions. Subtracting pending outflows again would double-count,
 *    so we take the reported balance as-is.
 *  - "manual" accounts: we ARE the ledger. Balance = opening + Σ non-removed
 *    transaction amounts (posted and pending both count against spendable cash).
 * The ledger computation is also what reconciliation compares against the
 * reported balance for plaid accounts (docs/verificationEngine.md).
 */
import type { MinorUnits } from "../money";
import { assertMinorUnits, sumMinor } from "../money";
import type { TransactionProjection } from "../projection/transactions";
import { effectiveTransactions } from "../projection/transactions";
import { historyReviewIssues } from "../projection/continuity";

export type AccountType =
  | "checking"
  | "savings"
  | "cash"
  | "credit"
  | "loan"
  | "investment"
  | "unknown";

export type ReconciliationStatus = "unknown" | "reconciled" | "minor_drift" | "failed";

export interface Account {
  accountId: string;
  type: AccountType;
  source: "plaid" | "manual";
  name: string;
  /** Bank-provided identifying suffix; display only, never used for merging. */
  mask?: string;
  institutionName?: string;
  currency: string;
  balanceCurrentMinor: MinorUnits;
  /** False means the zero value is only a storage placeholder because the
   * institution did not report a current balance. Absent means known for
   * backward compatibility with existing events. */
  balanceCurrentKnown?: boolean;
  balanceAvailableMinor?: MinorUnits;
  /** ISO UTC — the freshness anchor verification scores against. */
  balanceAsOf: string;
  status: "active" | "disconnected" | "closed";
  /** Manual accounts only: the ledger's starting point. */
  openingBalanceMinor?: MinorUnits;
  /** Aggregator accounts only: the item to target for on-demand refresh. */
  plaidItemId?: string;
  /** Bank accounts remain unknown until a trustworthy opening checkpoint and
   * sufficient transaction history establish a comparison. */
  reconciliationStatus?: ReconciliationStatus;
  reconciliationDriftMinor?: MinorUnits;
}

export interface Bucket {
  bucketId: string;
  name: string;
  allocatedMinor: MinorUnits;
  targetMinor?: MinorUnits;
}

export interface Bill {
  billId: string;
  name: string;
  expectedAmountMinor: MinorUnits;
  /** Local date YYYY-MM-DD (docs/DataModel.md timezone policy). */
  nextDue: string;
  kind?: "bill" | "subscription";
}

const CASH_TYPES: ReadonlySet<AccountType> = new Set(["checking", "savings", "cash"]);

/** Ledger balance for one account from the projection (manual accounts + reconciliation). */
export function computeLedgerBalanceMinor(
  account: Account,
  projection: TransactionProjection,
): MinorUnits {
  const opening = assertMinorUnits(account.openingBalanceMinor ?? 0, "opening balance");
  const amounts = effectiveTransactions(projection)
    .filter((t) => t.accountId === account.accountId && t.currency === account.currency)
    .map((t) => t.amountMinor);
  return opening + sumMinor(amounts);
}

export interface FinancialStateSnapshot {
  availableCashMinor: MinorUnits;
  bucketAllocatedMinor: MinorUnits;
  upcomingObligationsMinor: MinorUnits;
  /** Oldest balanceAsOf among included accounts — the honest data age. */
  dataAsOf: string;
  lastSequence: number;
  /** Cash before allocations, useful for explicitly identifying an existing
   * over-allocation after a bank balance falls. */
  cashBeforeBucketsMinor: MinorUnits;
  overallocatedMinor: MinorUnits;
  accountBalances: AccountBalanceAssessment[];
  unsupportedCurrencyAccountIds: string[];
  unknownTypeAccountIds: string[];
  unknownBalanceAccountIds: string[];
  unsupportedCurrencyTransactionIds: string[];
  historyWarnings: string[];
  reconciliationStatus: ReconciliationStatus | "not_required";
  reconciliationDriftMinor?: MinorUnits;
  reportedBalanceMinor?: MinorUnits;
}

export type AccountBalanceBasis =
  | "manual_ledger"
  | "reported_available"
  | "current_less_pending_outflows"
  | "excluded_currency"
  | "excluded_type"
  | "unknown_balance";

export interface AccountBalanceAssessment {
  accountId: string;
  source: Account["source"];
  currency: string;
  basis: AccountBalanceBasis;
  spendingCapacityMinor?: MinorUnits;
}

/**
 * Bills due within the horizon, counting from the beginning of time —
 * deliberately NOT bounded below by todayLocal. Bill has no paid/settled
 * status yet (occurrence tracking is separate, later work): an elapsed
 * nextDue is not evidence of payment, so an overdue bill must keep
 * reducing available cash until it's actually settled or edited, not
 * silently stop counting the moment its date passes.
 */
export function computeUpcomingObligationsMinor(
  bills: readonly Bill[],
  todayLocal: string,
  horizonDays = 30,
): MinorUnits {
  const horizon = addDaysLocal(todayLocal, horizonDays);
  return sumMinor(bills.filter((b) => b.nextDue <= horizon).map((b) => b.expectedAmountMinor));
}

export function computeFinancialState(input: {
  accounts: readonly Account[];
  projection: TransactionProjection;
  buckets: readonly Bucket[];
  bills: readonly Bill[];
  /** Local date YYYY-MM-DD in the user's timezone. Passed in — engines don't read clocks. */
  todayLocal: string;
}): FinancialStateSnapshot {
  const { accounts, projection, buckets, bills, todayLocal } = input;

  // One transaction pass builds both manual ledger deltas and the conservative
  // Plaid fallback. Pending inflows are intentionally absent from the latter.
  const ledgerDeltas = new Map<string, MinorUnits>();
  const pendingOutflows = new Map<string, MinorUnits>();
  const unsupportedCurrencyTransactionIds: string[] = [];
  for (const txn of effectiveTransactions(projection, { includeExcluded: true })) {
    if (txn.currency !== "USD") unsupportedCurrencyTransactionIds.push(txn.txnId);
    const key = accountCurrencyKey(txn.accountId, txn.currency);
    if (!txn.historyExclusion) ledgerDeltas.set(key, (ledgerDeltas.get(key) ?? 0) + txn.amountMinor);
    if (txn.status === "pending" && txn.amountMinor < 0) {
      pendingOutflows.set(key, (pendingOutflows.get(key) ?? 0) + txn.amountMinor);
    }
  }

  const accountBalances: AccountBalanceAssessment[] = [];
  const unsupportedCurrencyAccountIds: string[] = [];
  const unknownTypeAccountIds: string[] = [];
  const unknownBalanceAccountIds: string[] = [];
  const includedAccounts: Account[] = [];
  const plaidAccounts: Account[] = [];
  const capacities: MinorUnits[] = [];

  for (const account of accounts) {
    if (account.status !== "active") continue;
    if (account.type === "unknown") {
      unknownTypeAccountIds.push(account.accountId);
      accountBalances.push(balanceAssessment(account, "excluded_type"));
      continue;
    }
    if (!CASH_TYPES.has(account.type)) continue;
    if (account.currency !== "USD") {
      unsupportedCurrencyAccountIds.push(account.accountId);
      accountBalances.push(balanceAssessment(account, "excluded_currency"));
      continue;
    }

    const key = accountCurrencyKey(account.accountId, account.currency);
    let capacity: MinorUnits | undefined;
    let basis: AccountBalanceBasis;
    if (account.source === "manual") {
      capacity = assertMinorUnits(
        (account.openingBalanceMinor ?? 0) + (ledgerDeltas.get(key) ?? 0),
        "manual ledger balance",
      );
      basis = "manual_ledger";
    } else if (account.balanceAvailableMinor !== undefined) {
      capacity = assertMinorUnits(account.balanceAvailableMinor, "reported available balance");
      basis = "reported_available";
    } else if (account.balanceCurrentKnown !== false) {
      capacity = assertMinorUnits(
        account.balanceCurrentMinor + (pendingOutflows.get(key) ?? 0),
        "adjusted current balance",
      );
      basis = "current_less_pending_outflows";
    } else {
      basis = "unknown_balance";
      unknownBalanceAccountIds.push(account.accountId);
    }

    accountBalances.push(balanceAssessment(account, basis, capacity));
    if (capacity !== undefined) {
      capacities.push(capacity);
      includedAccounts.push(account);
      if (account.source === "plaid") plaidAccounts.push(account);
    }
  }

  const cash = sumMinor(capacities);

  const bucketAllocatedMinor = sumMinor(buckets.map((b) => b.allocatedMinor));
  const availableCashMinor = cash - bucketAllocatedMinor;
  const overallocatedMinor = Math.max(0, -availableCashMinor);

  const dataAsOf =
    includedAccounts.map((a) => a.balanceAsOf).sort()[0] ?? new Date(0).toISOString();

  const reconciliation = aggregateReconciliation(plaidAccounts);

  return {
    availableCashMinor: assertMinorUnits(availableCashMinor, "available cash"),
    bucketAllocatedMinor,
    upcomingObligationsMinor: computeUpcomingObligationsMinor(bills, todayLocal),
    dataAsOf,
    lastSequence: projection.lastSequence,
    cashBeforeBucketsMinor: cash,
    overallocatedMinor,
    accountBalances,
    unsupportedCurrencyAccountIds,
    unknownTypeAccountIds,
    unknownBalanceAccountIds,
    unsupportedCurrencyTransactionIds: [...new Set(unsupportedCurrencyTransactionIds)],
    historyWarnings: historyReviewIssues(projection),
    ...reconciliation,
  };
}

function accountCurrencyKey(accountId: string, currency: string): string {
  return `${accountId}\u0000${currency}`;
}

function balanceAssessment(
  account: Account,
  basis: AccountBalanceBasis,
  spendingCapacityMinor?: MinorUnits,
): AccountBalanceAssessment {
  return {
    accountId: account.accountId,
    source: account.source,
    currency: account.currency,
    basis,
    ...(spendingCapacityMinor !== undefined ? { spendingCapacityMinor } : {}),
  };
}

function aggregateReconciliation(accounts: readonly Account[]): Pick<
  FinancialStateSnapshot,
  "reconciliationStatus" | "reconciliationDriftMinor" | "reportedBalanceMinor"
> {
  if (accounts.length === 0) return { reconciliationStatus: "not_required" };
  const complete = accounts.every(
    (account) =>
      account.reconciliationStatus !== undefined &&
      account.reconciliationStatus !== "unknown" &&
      account.reconciliationDriftMinor !== undefined &&
      account.balanceCurrentKnown !== false,
  );
  if (!complete) return { reconciliationStatus: "unknown" };

  const rank: Record<Exclude<ReconciliationStatus, "unknown">, number> = {
    reconciled: 0,
    minor_drift: 1,
    failed: 2,
  };
  const known = accounts.map((account) => ({
    account,
    status: account.reconciliationStatus as Exclude<ReconciliationStatus, "unknown">,
    driftMinor: account.reconciliationDriftMinor!,
  }));
  const worst = known.reduce((a, b) =>
    rank[a.status] >= rank[b.status] ? a : b,
  ).status;
  return {
    reconciliationStatus: worst,
    reconciliationDriftMinor: sumMinor(
      known.map(({ driftMinor }) => Math.abs(driftMinor)),
    ),
    reportedBalanceMinor: sumMinor(
      known.map(({ account }) => Math.abs(account.balanceCurrentMinor)),
    ),
  };
}

/** Local-date arithmetic without timezones: parse as UTC noon to dodge DST edges. */
function addDaysLocal(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
