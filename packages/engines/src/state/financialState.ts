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
import type { MinorUnits } from "../money.js";
import { assertMinorUnits, sumMinor } from "../money.js";
import type { TransactionProjection } from "../projection/transactions.js";
import { effectiveTransactions } from "../projection/transactions.js";

export type AccountType = "checking" | "savings" | "cash" | "credit" | "loan" | "investment";

export interface Account {
  accountId: string;
  type: AccountType;
  source: "plaid" | "manual";
  name: string;
  currency: string;
  balanceCurrentMinor: MinorUnits;
  balanceAvailableMinor?: MinorUnits;
  /** ISO UTC — the freshness anchor verification scores against. */
  balanceAsOf: string;
  status: "active" | "disconnected" | "closed";
  /** Manual accounts only: the ledger's starting point. */
  openingBalanceMinor?: MinorUnits;
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
    .filter((t) => t.accountId === account.accountId)
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
}

export function computeUpcomingObligationsMinor(
  bills: readonly Bill[],
  todayLocal: string,
  horizonDays = 30,
): MinorUnits {
  const horizon = addDaysLocal(todayLocal, horizonDays);
  return sumMinor(
    bills
      .filter((b) => b.nextDue >= todayLocal && b.nextDue <= horizon)
      .map((b) => b.expectedAmountMinor),
  );
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

  const cashAccounts = accounts.filter((a) => CASH_TYPES.has(a.type) && a.status === "active");
  const cash = sumMinor(
    cashAccounts.map((a) =>
      a.source === "plaid"
        ? (a.balanceAvailableMinor ?? a.balanceCurrentMinor)
        : computeLedgerBalanceMinor(a, projection),
    ),
  );

  const bucketAllocatedMinor = sumMinor(buckets.map((b) => b.allocatedMinor));
  const availableCashMinor = cash - bucketAllocatedMinor;

  const dataAsOf =
    cashAccounts.map((a) => a.balanceAsOf).sort()[0] ?? new Date(0).toISOString();

  return {
    availableCashMinor: assertMinorUnits(availableCashMinor, "available cash"),
    bucketAllocatedMinor,
    upcomingObligationsMinor: computeUpcomingObligationsMinor(bills, todayLocal),
    dataAsOf,
    lastSequence: projection.lastSequence,
  };
}

/** Local-date arithmetic without timezones: parse as UTC noon to dodge DST edges. */
function addDaysLocal(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
