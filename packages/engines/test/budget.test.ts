import { describe, expect, it } from "vitest";
import {
  advanceSnapshot,
  buildSnapshot,
  budgetProgress,
  computeFinancialState,
  emptySnapshot,
  foldBudgetPlans,
  type EventEnvelope,
} from "../src";

let seq = 0;
function event(type: string, payload: unknown): EventEnvelope {
  seq += 1;
  return {
    eventId: `e-${seq}`,
    sequence: seq,
    type,
    schemaVersion: 1,
    occurredAt: "2026-06-12T10:00:00.000Z",
    source: "user",
    idempotencyKey: `k-${seq}`,
    payload,
  } as EventEnvelope;
}

function plan(id: string, categoryId: string, month: string, limitMinor: number, enabled = true) {
  return event("BudgetPlanUpserted", { budgetPlanId: id, categoryId, month, limitMinor, enabled });
}

function posted(txnId: string, amountMinor: number, postedDate: string, category: string) {
  return event("TransactionPosted", {
    txnId,
    accountId: "acct-1",
    amountMinor,
    currency: "USD",
    status: "posted",
    postedDate,
    merchantRaw: txnId,
    category,
    categorySource: "user",
  });
}

const account = event("AccountUpserted", {
  accountId: "acct-1",
  type: "checking",
  source: "manual",
  name: "Checking",
  currency: "USD",
  balanceCurrentMinor: 0,
  balanceAsOf: "2026-06-12T10:00:00.000Z",
  status: "active",
  openingBalanceMinor: 1_000_000,
});

describe("foldBudgetPlans", () => {
  it("last-write-wins per id; a later edit to the SAME (category, month) id replaces it", () => {
    seq = 0;
    const plans = foldBudgetPlans([
      plan("dining:2026-06", "Dining", "2026-06", 40_000),
      plan("dining:2026-06", "Dining", "2026-06", 50_000), // edit: same id
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.limitMinor).toBe(50_000);
  });

  it("a new month gets a new id and does not erase the prior month's plan", () => {
    seq = 0;
    const plans = foldBudgetPlans([
      plan("dining:2026-05", "Dining", "2026-05", 30_000),
      plan("dining:2026-06", "Dining", "2026-06", 40_000),
    ]);
    expect(plans).toHaveLength(2);
    expect(plans.find((p) => p.month === "2026-05")?.limitMinor).toBe(30_000);
    expect(plans.find((p) => p.month === "2026-06")?.limitMinor).toBe(40_000);
  });

  it("skips malformed payloads rather than throwing (poison-pill defense)", () => {
    seq = 0;
    const malformed = event("BudgetPlanUpserted", { budgetPlanId: "x", categoryId: "Dining" }); // missing month/limitMinor/enabled
    expect(() => foldBudgetPlans([malformed])).not.toThrow();
    expect(foldBudgetPlans([malformed])).toHaveLength(0);
  });
});

describe("ProjectionSnapshot integration", () => {
  it("advancing incrementally (including a later edit) matches a full rebuild, same as buckets/bills", () => {
    seq = 0;
    const events = [
      plan("dining:2026-06", "Dining", "2026-06", 40_000),
      plan("groceries:2026-06", "Groceries", "2026-06", 60_000),
      plan("dining:2026-06", "Dining", "2026-06", 45_000), // edit, arrives in the second batch
    ];
    const rebuilt = buildSnapshot(events);
    const incremental = advanceSnapshot(
      advanceSnapshot(emptySnapshot(), events.slice(0, 2)),
      events.slice(2),
    );
    expect([...incremental.budgetPlans].sort((a, b) => a.budgetPlanId.localeCompare(b.budgetPlanId))).toEqual(
      [...rebuilt.budgetPlans].sort((a, b) => a.budgetPlanId.localeCompare(b.budgetPlanId)),
    );
    expect(incremental.budgetPlans.find((p) => p.categoryId === "Dining")?.limitMinor).toBe(45_000);
  });

  it("a budget plan existing has ZERO effect on computeFinancialState's available cash", () => {
    seq = 0;
    const withoutBudget = buildSnapshot([account, posted("t-1", -5_000, "2026-06-10", "Dining")]);
    const withBudget = buildSnapshot([
      account,
      posted("t-1", -5_000, "2026-06-10", "Dining"),
      plan("dining:2026-06", "Dining", "2026-06", 1), // a $0.01 limit — if this ever leaked
      // into cash math, available cash would collapse toward zero/negative.
    ]);
    const stateWithout = computeFinancialState({
      accounts: withoutBudget.accounts,
      projection: withoutBudget.transactions,
      buckets: withoutBudget.buckets,
      bills: withoutBudget.bills,
      todayLocal: "2026-06-12",
    });
    const stateWith = computeFinancialState({
      accounts: withBudget.accounts,
      projection: withBudget.transactions,
      buckets: withBudget.buckets,
      bills: withBudget.bills,
      todayLocal: "2026-06-12",
    });
    expect(stateWith.availableCashMinor).toBe(stateWithout.availableCashMinor);
    // computeFinancialState's input type has no budgetPlans field at all —
    // this assertion is a behavioral guard; the type signature itself is the
    // structural one (TypeScript would reject passing budgetPlans in).
  });
});

describe("budgetProgress", () => {
  it("computes spent/pending/remaining/overLimit per category for the given month only", () => {
    seq = 0;
    const snap = buildSnapshot([
      account,
      posted("t-1", -25_000, "2026-06-05", "Dining"),
      posted("t-2", -20_000, "2026-06-15", "Dining"),
      posted("t-3", -9_999, "2026-07-01", "Dining"), // outside June
      plan("dining:2026-06", "Dining", "2026-06", 40_000),
    ]);
    const rows = budgetProgress(snap.transactions, snap.budgetPlans, "2026-06");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      categoryId: "Dining",
      limitMinor: 40_000,
      spentMinor: 45_000,
      remainingMinor: -5_000,
      overLimitMinor: 5_000,
    });
  });

  it("pending spend is reported separately and does not count toward overLimit", () => {
    seq = 0;
    const pendingTxn = event("TransactionPosted", {
      txnId: "p-1",
      accountId: "acct-1",
      amountMinor: -10_000,
      currency: "USD",
      status: "pending",
      postedDate: "2026-06-05",
      merchantRaw: "p-1",
      category: "Dining",
      categorySource: "user",
    });
    const snap = buildSnapshot([account, pendingTxn, plan("dining:2026-06", "Dining", "2026-06", 40_000)]);
    const [row] = budgetProgress(snap.transactions, snap.budgetPlans, "2026-06");
    expect(row).toMatchObject({ spentMinor: 0, pendingMinor: 10_000, remainingMinor: 40_000, overLimitMinor: 0 });
  });

  it("only returns plans for the requested month", () => {
    seq = 0;
    const snap = buildSnapshot([
      account,
      plan("dining:2026-05", "Dining", "2026-05", 30_000),
      plan("dining:2026-06", "Dining", "2026-06", 40_000),
    ]);
    const rows = budgetProgress(snap.transactions, snap.budgetPlans, "2026-06");
    expect(rows.map((r) => r.month)).toEqual(["2026-06"]);
  });
});
