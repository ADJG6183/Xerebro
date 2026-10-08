/**
 * Summary queries — balances, net worth, and upcoming bills — folded
 * deterministically from the event log (docs/copilotArchitecture.md).
 */
import type { EventEnvelope, TransactionEvent } from "../events";
import type { MinorUnits } from "../money";
import { TRANSACTION_EVENT_TYPES } from "../projection/snapshot";
import { sumMinor } from "../money";
import { foldAccounts } from "../projection/accounts";
import { foldBills, foldBuckets } from "../projection/plans";
import {
  applyEvents,
  emptyProjection,
  type TransactionProjection,
} from "../projection/transactions";
import {
  computeFinancialState,
  computeLedgerBalanceMinor,
  type Account,
  type Bill,
} from "../state/financialState";

const LIABILITY_TYPES = new Set(["credit", "loan"]);

function projectionOf(events: readonly EventEnvelope[]): TransactionProjection {
  return applyEvents(
    emptyProjection(),
    events.filter((e): e is TransactionEvent => TRANSACTION_EVENT_TYPES.has(e.type)),
  );
}

/** Current balance for one account: ledger for manual, reported for plaid. */
function currentBalance(account: Account, projection: TransactionProjection): MinorUnits {
  return account.source === "manual"
    ? computeLedgerBalanceMinor(account, projection)
    : account.balanceCurrentMinor;
}

export interface FinancialSummary {
  availableCashMinor: MinorUnits;
  /** Assets minus liabilities across all active accounts. */
  netWorthMinor: MinorUnits;
  /** Accounts intentionally excluded rather than silently treated as USD/known. */
  excludedAccountIds: string[];
}

export function financialSummary(
  events: readonly EventEnvelope[],
  todayLocal: string,
): FinancialSummary {
  const accounts = foldAccounts(events);
  const projection = projectionOf(events);
  const state = computeFinancialState({
    accounts,
    projection,
    buckets: foldBuckets(events),
    bills: foldBills(events),
    todayLocal,
  });

  const includedForNetWorth = accounts.filter(
    (account) =>
      account.status === "active" &&
      account.currency === "USD" &&
      account.type !== "unknown" &&
      !(account.source === "plaid" && account.balanceCurrentKnown === false),
  );
  const netWorthMinor = includedForNetWorth
    .reduce((sum, a) => {
      const balance = currentBalance(a, projection);
      return sum + (LIABILITY_TYPES.has(a.type) ? -balance : balance);
    }, 0);

  const includedIds = new Set(includedForNetWorth.map((account) => account.accountId));
  return {
    availableCashMinor: state.availableCashMinor,
    netWorthMinor,
    excludedAccountIds: accounts
      .filter((account) => account.status === "active" && !includedIds.has(account.accountId))
      .map((account) => account.accountId),
  };
}

export interface DueBill {
  name: string;
  amountMinor: MinorUnits;
  nextDue: string;
}

export interface BillsDue {
  items: DueBill[];
  totalMinor: MinorUnits;
}

/** Bills due from today through the next `withinDays` (default 30), soonest first. */
export function billsDue(
  events: readonly EventEnvelope[],
  args: { today: string; withinDays?: number },
): BillsDue {
  const horizon = addDaysLocal(args.today, args.withinDays ?? 30);
  const items = foldBills(events)
    .filter((b: Bill) => b.nextDue >= args.today && b.nextDue <= horizon)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
    .map((b) => ({ name: b.name, amountMinor: b.expectedAmountMinor, nextDue: b.nextDue }));
  return { items, totalMinor: sumMinor(items.map((i) => i.amountMinor)) };
}

function addDaysLocal(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
