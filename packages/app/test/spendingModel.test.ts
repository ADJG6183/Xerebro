import { buildSnapshot, type EventEnvelope } from "@xerebro/engines";
import { describe, expect, it } from "vitest";
import { buildSpendingViewModel } from "../src/data/spendingModel";
import { accountUpserted, manualTransaction, type EventFactoryDeps } from "../src/data/userEvents";

const deps: EventFactoryDeps = {
  newId: (() => {
    let n = 0;
    return () => `id-${++n}`;
  })(),
  nowIso: () => "2026-06-15T08:00:00.000Z",
  deviceId: "device-a",
};

function sequenced(events: Omit<EventEnvelope, "sequence">[]): EventEnvelope[] {
  return events.map((e, i) => ({ ...e, sequence: i + 1 }) as EventEnvelope);
}

const ACCOUNT_A = accountUpserted(deps, {
  accountId: "acct-a",
  type: "checking",
  source: "manual",
  name: "Checking",
  currency: "USD",
  balanceCurrentMinor: 0,
  balanceAsOf: "2026-06-15T08:00:00.000Z",
  status: "active",
  openingBalanceMinor: 1_000_000,
});

const ACCOUNT_B = accountUpserted(deps, {
  accountId: "acct-b",
  type: "credit",
  source: "manual",
  name: "Card",
  currency: "USD",
  balanceCurrentMinor: 0,
  balanceAsOf: "2026-06-15T08:00:00.000Z",
  status: "active",
  openingBalanceMinor: 0,
});

function posted(txnId: string, accountId: string, amountMinor: number, postedDate: string, category?: string) {
  return manualTransaction(deps, {
    txnId,
    accountId,
    amountMinor,
    currency: "USD",
    status: "posted",
    postedDate,
    merchantRaw: txnId,
    ...(category ? { category } : {}),
    categorySource: "user",
  });
}

describe("buildSpendingViewModel", () => {
  it("scopes total and category breakdown to the selected month, excluding other months", () => {
    const events = sequenced([
      ACCOUNT_A,
      posted("rent", "acct-a", -120_000, "2026-06-01", "Housing"),
      posted("groceries", "acct-a", -6_842, "2026-06-10", "Groceries"),
      posted("july-txn", "acct-a", -9_999, "2026-07-01", "Dining"), // outside June
    ]);
    const vm = buildSpendingViewModel(buildSnapshot(events), { month: "2026-06", todayLocal: "2026-06-15" });
    expect(vm.totalSpentFormatted).toBe("$1,268.42"); // 1200 + 68.42
    expect(vm.categories.map((c) => c.category)).toEqual(["Housing", "Groceries"]);
    expect(vm.groups.flatMap((g) => g.items).map((t) => t.txnId)).not.toContain("july-txn");
  });

  it("pending spend is shown separately and never folded into the settled total", () => {
    const events = sequenced([
      ACCOUNT_A,
      posted("rent", "acct-a", -120_000, "2026-06-01", "Housing"),
      manualTransaction(deps, {
        txnId: "pending-1",
        accountId: "acct-a",
        amountMinor: -2_000,
        currency: "USD",
        status: "pending",
        postedDate: "2026-06-12",
        merchantRaw: "pending-1",
        categorySource: "user",
      }),
    ]);
    const vm = buildSpendingViewModel(buildSnapshot(events), { month: "2026-06", todayLocal: "2026-06-15" });
    expect(vm.totalSpentFormatted).toBe("$1,200.00");
    expect(vm.pendingSpentFormatted).toBe("$20.00");
    // Still visible in the list, just not counted toward the settled total.
    expect(vm.groups.flatMap((g) => g.items).map((t) => t.txnId)).toContain("pending-1");
  });

  it("a category filter matches case-insensitively and keeps the total and list in agreement", () => {
    const events = sequenced([
      ACCOUNT_A,
      posted("g1", "acct-a", -1_000, "2026-06-05", "Groceries"),
      posted("g2", "acct-a", -2_000, "2026-06-06", "Groceries"),
      posted("d1", "acct-a", -3_000, "2026-06-07", "Dining"),
    ]);
    const vm = buildSpendingViewModel(buildSnapshot(events), {
      month: "2026-06",
      todayLocal: "2026-06-15",
      filters: { category: "groceries" }, // lowercase on purpose
    });
    expect(vm.totalSpentFormatted).toBe("$30.00");
    const shown = vm.groups.flatMap((g) => g.items);
    expect(shown.map((t) => t.txnId).sort()).toEqual(["g1", "g2"]);
  });

  it("an account filter scopes the list to that account only", () => {
    const events = sequenced([
      ACCOUNT_A,
      ACCOUNT_B,
      posted("a-txn", "acct-a", -1_000, "2026-06-05"),
      posted("b-txn", "acct-b", -2_000, "2026-06-06"),
    ]);
    const vm = buildSpendingViewModel(buildSnapshot(events), {
      month: "2026-06",
      todayLocal: "2026-06-15",
      filters: { accountId: "acct-b" },
    });
    expect(vm.groups.flatMap((g) => g.items).map((t) => t.txnId)).toEqual(["b-txn"]);
  });

  it("search reaches the complete local history, not just the selected month", () => {
    const events = sequenced([
      ACCOUNT_A,
      posted("old-coffee", "acct-a", -450, "2026-01-03", "Dining"),
      posted("june-rent", "acct-a", -120_000, "2026-06-01", "Housing"),
    ]);
    // Viewing June, searching for something that only exists back in January.
    const vm = buildSpendingViewModel(buildSnapshot(events), {
      month: "2026-06",
      todayLocal: "2026-06-15",
      filters: { search: "coffee" },
    });
    expect(vm.searchingAllHistory).toBe(true);
    expect(vm.groups.flatMap((g) => g.items).map((t) => t.txnId)).toEqual(["old-coffee"]);
  });

  it("caps the materialized list at `limit` and reports the true result count", () => {
    const txns = Array.from({ length: 10 }, (_, i) =>
      posted(`t-${i}`, "acct-a", -100, `2026-06-${String(i + 1).padStart(2, "0")}`),
    );
    const events = sequenced([ACCOUNT_A, ...txns]);
    const vm = buildSpendingViewModel(buildSnapshot(events), {
      month: "2026-06",
      todayLocal: "2026-06-15",
      limit: 3,
    });
    expect(vm.resultCount).toBe(10);
    expect(vm.shownCount).toBe(3);
    expect(vm.groups.flatMap((g) => g.items)).toHaveLength(3);
  });
});
