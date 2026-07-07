import { describe, expect, it } from "vitest";
import { buildDashboardViewModel, dataAgeLabel } from "../src/data/dashboardModel";
import { accountUpserted, manualTransaction, type EventFactoryDeps } from "../src/data/userEvents";
import type { EventEnvelope } from "@xerebro/engines";

const deps: EventFactoryDeps = {
  newId: (() => {
    let n = 0;
    return () => `id-${++n}`;
  })(),
  nowIso: () => "2026-07-07T08:00:00.000Z",
  deviceId: "device-a",
};

function sequenced(events: Omit<EventEnvelope, "sequence">[]): EventEnvelope[] {
  return events.map((e, i) => ({ ...e, sequence: i + 1 }) as EventEnvelope);
}

describe("dashboard view-model", () => {
  it("empty log → onboarding state with honest labels", () => {
    const vm = buildDashboardViewModel({
      events: [],
      todayLocal: "2026-07-07",
      nowIso: "2026-07-07T10:00:00.000Z",
    });
    expect(vm.hasAccounts).toBe(false);
    expect(vm.availableCashFormatted).toBe("$0.00");
    expect(vm.dataAgeLabel).toBe("no accounts yet");
    expect(vm.recentTransactions).toEqual([]);
  });

  it("formats amounts with sign and marks pending", () => {
    const events = sequenced([
      accountUpserted(deps, {
        accountId: "a",
        type: "checking",
        source: "manual",
        name: "A",
        currency: "USD",
        balanceCurrentMinor: 0,
        balanceAsOf: "2026-07-07T08:00:00.000Z",
        status: "active",
        openingBalanceMinor: 100_000,
      }),
      manualTransaction(deps, {
        txnId: "t1",
        accountId: "a",
        amountMinor: -1_500,
        currency: "USD",
        status: "pending",
        postedDate: "2026-07-07",
        merchantRaw: "Coffee",
        categorySource: "user",
      }),
      manualTransaction(deps, {
        txnId: "t2",
        accountId: "a",
        amountMinor: 240_000,
        currency: "USD",
        status: "posted",
        postedDate: "2026-07-06",
        merchantRaw: "Salary",
        categorySource: "user",
      }),
    ]);
    const vm = buildDashboardViewModel({
      events,
      todayLocal: "2026-07-07",
      nowIso: "2026-07-07T09:00:00.000Z",
    });
    expect(vm.availableCashFormatted).toBe("$3,385.00"); // 1,000 − 15 + 2,400
    const [first, second] = vm.recentTransactions;
    expect(first).toMatchObject({ merchant: "Coffee", amountFormatted: "-$15.00", pending: true });
    expect(second).toMatchObject({ merchant: "Salary", amountFormatted: "+$2,400.00", isInflow: true });
  });

  it("data-age labels follow the read-only freshness tiers", () => {
    const t0 = "2026-07-07T00:00:00.000Z";
    expect(dataAgeLabel(t0, "2026-07-07T00:30:00.000Z", true)).toBe("up to date");
    expect(dataAgeLabel(t0, "2026-07-07T14:00:00.000Z", true)).toBe("as of 14h ago");
    expect(dataAgeLabel(t0, "2026-07-08T10:00:00.000Z", true)).toBe("as of yesterday or earlier");
    expect(dataAgeLabel(t0, "2026-07-11T00:00:00.000Z", true)).toBe("stale — reconnect your bank");
  });
});
