import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyEvents, emptyProjection } from "../src/projection/transactions";
import { computeFinancialState, type Account } from "../src/state/financialState";
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
});
