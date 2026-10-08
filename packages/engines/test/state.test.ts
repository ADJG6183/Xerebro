import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyEvents, emptyProjection } from "../src/projection/transactions";
import {
  computeFinancialState,
  computeUpcomingObligationsMinor,
  type Account,
  type Bill,
} from "../src/state/financialState";
import { posted } from "./helpers";

const manual = (opening: number): Account => ({
  accountId: "acc-1",
  type: "checking",
  source: "manual",
  name: "Manual Checking",
  currency: "USD",
  balanceCurrentMinor: 0,
  balanceAsOf: "2026-07-07T08:00:00.000Z",
  status: "active",
  openingBalanceMinor: opening,
});

describe("financial state engine", () => {
  it("PROPERTY: available cash is always integer minor units (no float leaks)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(fc.integer({ min: -200_000, max: 200_000 }), { maxLength: 20 }),
        fc.integer({ min: 0, max: 500_000 }),
        (opening, amounts, allocated) => {
          const projection = applyEvents(
            emptyProjection(),
            amounts.map((amt, i) => posted(`txn-${i}`, amt, i + 1)),
          );
          const state = computeFinancialState({
            accounts: [manual(opening)],
            projection,
            buckets: [{ bucketId: "b", name: "b", allocatedMinor: allocated }],
            bills: [],
            todayLocal: "2026-07-07",
          });
          expect(Number.isSafeInteger(state.availableCashMinor)).toBe(true);
          expect(state.availableCashMinor).toBe(
            opening + amounts.reduce((a, b) => a + b, 0) - allocated,
          );
        },
      ),
    );
  });

  it("plaid accounts use the bank-reported available balance (no pending double-count)", () => {
    // The bank's available balance ALREADY nets the pending txn below.
    const plaid: Account = {
      accountId: "acc-p",
      type: "checking",
      source: "plaid",
      name: "Plaid Checking",
      currency: "USD",
      balanceCurrentMinor: 500_000,
      balanceAvailableMinor: 485_000,
      balanceAsOf: "2026-07-07T08:00:00.000Z",
      status: "active",
    };
    const projection = applyEvents(emptyProjection(), [
      posted("txn-pend", -15_000, 1, { status: "pending", accountId: "acc-p" }),
    ]);
    const state = computeFinancialState({
      accounts: [plaid],
      projection,
      buckets: [],
      bills: [],
      todayLocal: "2026-07-07",
    });
    expect(state.availableCashMinor).toBe(485_000); // NOT 470_000
  });

  it("falls back to current minus pending withdrawals, never pending deposits", () => {
    const plaid: Account = {
      accountId: "acc-p",
      type: "checking",
      source: "plaid",
      name: "Plaid Checking",
      currency: "USD",
      balanceCurrentMinor: 500_000,
      balanceAsOf: "2026-07-07T08:00:00.000Z",
      status: "active",
    };
    const projection = applyEvents(emptyProjection(), [
      posted("pending-out", -15_000, 1, { status: "pending", accountId: "acc-p" }),
      posted("pending-in", 20_000, 2, { status: "pending", accountId: "acc-p" }),
    ]);

    const state = computeFinancialState({
      accounts: [plaid],
      projection,
      buckets: [],
      bills: [],
      todayLocal: "2026-07-07",
    });

    expect(state.availableCashMinor).toBe(485_000);
    expect(state.accountBalances[0]?.basis).toBe("current_less_pending_outflows");
  });

  it("excludes unsupported currencies, unknown account types, and unknown balances", () => {
    const accounts: Account[] = [
      { ...manual(100_000), currency: "EUR" },
      { ...manual(200_000), accountId: "unknown-type", type: "unknown" },
      {
        ...manual(0),
        accountId: "unknown-balance",
        source: "plaid",
        balanceCurrentKnown: false,
      },
      { ...manual(300_000), accountId: "known-usd" },
    ];
    const state = computeFinancialState({
      accounts,
      projection: emptyProjection(),
      buckets: [],
      bills: [],
      todayLocal: "2026-07-07",
    });

    expect(state.availableCashMinor).toBe(300_000);
    expect(state.unsupportedCurrencyAccountIds).toEqual(["acc-1"]);
    expect(state.unknownTypeAccountIds).toEqual(["unknown-type"]);
    expect(state.unknownBalanceAccountIds).toEqual(["unknown-balance"]);
  });

  it("reports allocations that exceed known cash instead of hiding the condition", () => {
    const state = computeFinancialState({
      accounts: [manual(100_000)],
      projection: emptyProjection(),
      buckets: [{ bucketId: "b", name: "Bills", allocatedMinor: 125_000 }],
      bills: [],
      todayLocal: "2026-07-07",
    });

    expect(state.availableCashMinor).toBe(-25_000);
    expect(state.overallocatedMinor).toBe(25_000);
  });

  it("does not mix a foreign-currency transaction into a USD ledger", () => {
    const projection = applyEvents(emptyProjection(), [
      posted("foreign", -10_000, 1, { accountId: "acc-1", currency: "EUR" }),
    ]);
    const state = computeFinancialState({
      accounts: [manual(100_000)],
      projection,
      buckets: [],
      bills: [],
      todayLocal: "2026-07-07",
    });

    expect(state.availableCashMinor).toBe(100_000);
    expect(state.unsupportedCurrencyTransactionIds).toEqual(["foreign"]);
  });

  it("disconnected and non-cash accounts are excluded from available cash", () => {
    const accounts: Account[] = [
      manual(100_000),
      { ...manual(999_999), accountId: "acc-2", status: "disconnected" },
      { ...manual(999_999), accountId: "acc-3", type: "credit" },
    ];
    const state = computeFinancialState({
      accounts,
      projection: emptyProjection(),
      buckets: [],
      bills: [],
      todayLocal: "2026-07-07",
    });
    expect(state.availableCashMinor).toBe(100_000);
  });

  it("dataAsOf is the OLDEST balance among included accounts (honest data age)", () => {
    const accounts: Account[] = [
      { ...manual(0), balanceAsOf: "2026-07-07T08:00:00.000Z" },
      { ...manual(0), accountId: "acc-2", balanceAsOf: "2026-07-05T08:00:00.000Z" },
    ];
    const state = computeFinancialState({
      accounts,
      projection: emptyProjection(),
      buckets: [],
      bills: [],
      todayLocal: "2026-07-07",
    });
    expect(state.dataAsOf).toBe("2026-07-05T08:00:00.000Z");
  });

  it("an overdue bill keeps reducing available cash — an elapsed due date is not evidence of payment", () => {
    const bill: Bill = { billId: "rent", name: "Rent", expectedAmountMinor: 180_000, nextDue: "2026-07-01" };
    // "Today" is 6 days AFTER the bill was due — it has no paid/settled
    // status (occurrence tracking is separate, later work), so it must
    // still count.
    const state = computeFinancialState({
      accounts: [manual(500_000)],
      projection: emptyProjection(),
      buckets: [],
      bills: [bill],
      todayLocal: "2026-07-07",
    });
    expect(state.upcomingObligationsMinor).toBe(180_000);
  });

  it("computeUpcomingObligationsMinor: overdue bills count, bills past the horizon don't", () => {
    const overdue: Bill = { billId: "b1", name: "Overdue", expectedAmountMinor: 10_000, nextDue: "2026-06-01" };
    const soon: Bill = { billId: "b2", name: "Soon", expectedAmountMinor: 20_000, nextDue: "2026-07-10" };
    const farOut: Bill = { billId: "b3", name: "Far", expectedAmountMinor: 40_000, nextDue: "2026-09-01" };
    const total = computeUpcomingObligationsMinor([overdue, soon, farOut], "2026-07-07", 30);
    expect(total).toBe(30_000); // overdue + soon; farOut is past the 30-day horizon
  });
});
