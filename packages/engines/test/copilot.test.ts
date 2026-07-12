import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../src/events";
import { spendByCategory, spendTotal, topCategories } from "../src/queries/spending";
import { billsDue, financialSummary } from "../src/queries/summary";
import { dispatchTool, toolSchemas, UnknownToolError, ToolArgError } from "../src/copilot/tools";
import { checkChatFaithful } from "../src/explanation/faithfulness";

let seq = 0;
function ev(type: string, payload: unknown, source: "user" | "plaid" = "user"): EventEnvelope {
  seq += 1;
  return {
    eventId: `e-${seq}`,
    sequence: seq,
    type,
    schemaVersion: 1,
    occurredAt: "2026-07-12T10:00:00.000Z",
    source,
    idempotencyKey: `k-${seq}`,
    payload,
  } as EventEnvelope;
}

function txn(txnId: string, amountMinor: number, postedDate: string, category?: string): EventEnvelope {
  return ev("TransactionPosted", {
    txnId,
    accountId: "acc-1",
    amountMinor,
    currency: "USD",
    status: "posted",
    postedDate,
    merchantRaw: txnId,
    ...(category ? { category } : {}),
    categorySource: "user",
  });
}

function fixture(): EventEnvelope[] {
  seq = 0;
  return [
    ev("AccountUpserted", {
      accountId: "acc-1",
      type: "checking",
      source: "manual",
      name: "Checking",
      currency: "USD",
      balanceCurrentMinor: 0,
      balanceAsOf: "2026-07-12T10:00:00.000Z",
      status: "active",
      openingBalanceMinor: 500_000,
    }),
    txn("t-rent", -120_000, "2026-06-03", "Housing"),
    txn("t-groceries-1", -6_842, "2026-06-10", "Groceries"),
    txn("t-groceries-2", -4_158, "2026-06-20", "Groceries"),
    txn("t-dining", -3_000, "2026-06-15", "Dining"),
    txn("t-salary", 240_000, "2026-06-01", "Income"), // inflow — never "spending"
    txn("t-july", -9_999, "2026-07-05", "Dining"), // outside June
    ev("BillUpserted", { billId: "b1", name: "Electricity", expectedAmountMinor: 7_430, nextDue: "2026-07-18" }),
    ev("BillUpserted", { billId: "b2", name: "Insurance", expectedAmountMinor: 12_000, nextDue: "2026-09-01" }),
  ];
}

const JUNE = { fromDate: "2026-06-01", toDate: "2026-06-30" };

describe("spending queries", () => {
  it("spendTotal counts only outflows in range; income never counts", () => {
    expect(spendTotal(fixture(), JUNE)).toBe(120_000 + 6_842 + 4_158 + 3_000);
  });

  it("spendTotal filters by category (case-insensitive)", () => {
    expect(spendTotal(fixture(), { ...JUNE, category: "groceries" })).toBe(11_000);
  });

  it("spendByCategory groups and sorts largest first; excludes the July txn", () => {
    const rows = spendByCategory(fixture(), JUNE);
    expect(rows.map((r) => r.category)).toEqual(["Housing", "Groceries", "Dining"]);
    expect(rows.find((r) => r.category === "Groceries")!.totalMinor).toBe(11_000);
  });

  it("topCategories caps the list", () => {
    expect(topCategories(fixture(), { ...JUNE, limit: 2 }).map((r) => r.category)).toEqual([
      "Housing",
      "Groceries",
    ]);
  });
});

describe("summary queries", () => {
  it("financialSummary reflects the ledger: opening + all txns", () => {
    // 5000 − 1200 − 68.42 − 41.58 − 30 + 2400 − 99.99 = $5,960.01
    const s = financialSummary(fixture(), "2026-07-12");
    expect(s.availableCashMinor).toBe(596_001);
    expect(s.netWorthMinor).toBe(596_001); // single asset account
  });

  it("billsDue looks ahead a window, soonest first, and totals", () => {
    const due = billsDue(fixture(), { today: "2026-07-12", withinDays: 30 });
    expect(due.items.map((b) => b.name)).toEqual(["Electricity"]); // Insurance is 51 days out
    expect(due.totalMinor).toBe(7_430);
  });
});

describe("tool dispatch", () => {
  it("schemas expose every tool with params for the router", () => {
    const names = toolSchemas().map((t) => t.name);
    expect(names).toContain("spend_total");
    expect(names).toContain("financial_summary");
    expect(names).toContain("bills_due");
  });

  it("dispatch runs a tool and returns figures matching its data", () => {
    const result = dispatchTool("spend_total", fixture(), { ...JUNE, category: "Dining" }, { todayLocal: "2026-07-12" });
    expect(result.data.total).toBe("$30.00");
    expect(result.figures).toEqual([3_000]);
  });

  it("financial_summary needs no date args, uses today from context", () => {
    const result = dispatchTool("financial_summary", fixture(), {}, { todayLocal: "2026-07-12" });
    expect(result.data.availableCash).toBe("$5,960.01");
    expect(result.figures).toContain(596_001);
  });

  it("unknown tool and bad args throw typed errors (router can recover)", () => {
    expect(() => dispatchTool("nope", [], {}, { todayLocal: "2026-07-12" })).toThrow(UnknownToolError);
    expect(() => dispatchTool("spend_total", [], { fromDate: "June" }, { todayLocal: "2026-07-12" })).toThrow(
      ToolArgError,
    );
  });
});

describe("chat faithfulness", () => {
  it("accepts answers whose figures the tool computed", () => {
    const result = dispatchTool("spend_by_category", fixture(), JUNE, { todayLocal: "2026-07-12" });
    const answer = "You spent $1,200.00 on Housing and $110.00 on Groceries in June.";
    expect(checkChatFaithful(answer, result.figures).faithful).toBe(true);
  });

  it("rejects an invented figure the tools never produced", () => {
    const result = dispatchTool("spend_total", fixture(), JUNE, { todayLocal: "2026-07-12" });
    // $1,340.00 is the real total; $250.00 is invented.
    const bad = checkChatFaithful("You spent $1,340.00, similar to the $250.00 average shopper.", result.figures);
    expect(bad.faithful).toBe(false);
    expect(bad.violations[0]).toContain("$250.00");
  });
});
