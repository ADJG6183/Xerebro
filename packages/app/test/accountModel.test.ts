import { describe, expect, it } from "vitest";
import { buildSnapshot, type EventEnvelope } from "@xerebro/engines";
import { buildAccountViewModel } from "../src/data/accountModel";

function event(type: string, payload: unknown, sequence: number): EventEnvelope {
  return {
    eventId: `e-${sequence}`,
    sequence,
    type,
    schemaVersion: 1,
    occurredAt: "2026-09-05T12:00:00.000Z",
    source: type === "TransactionPosted" ? "plaid" : "system",
    idempotencyKey: `k-${sequence}`,
    payload,
  };
}

describe("account view model", () => {
  it("groups connected and manual accounts from the local projection", () => {
    const common = {
      currency: "USD",
      balanceAsOf: "2026-09-05T11:00:00.000Z",
      status: "active" as const,
    };
    const snapshot = buildSnapshot([
      event("AccountUpserted", {
        ...common,
        accountId: "bank-checking",
        type: "checking",
        source: "plaid",
        name: "Everyday Checking",
        mask: "1234",
        balanceCurrentMinor: 125_000,
        balanceAvailableMinor: 120_000,
        plaidItemId: "item-1",
        reconciliationStatus: "unknown",
      }, 1),
      event("AccountUpserted", {
        ...common,
        accountId: "bank-credit",
        type: "credit",
        source: "plaid",
        name: "Rewards Card",
        mask: "9999",
        balanceCurrentMinor: 20_000,
        plaidItemId: "item-1",
        reconciliationStatus: "unknown",
      }, 2),
      event("AccountUpserted", {
        ...common,
        accountId: "manual-cash",
        type: "cash",
        source: "manual",
        name: "Wallet",
        balanceCurrentMinor: 0,
        openingBalanceMinor: 5_000,
      }, 3),
      event("TransactionPosted", {
        txnId: "coffee",
        accountId: "bank-checking",
        amountMinor: -500,
        currency: "USD",
        status: "posted",
        postedDate: "2026-09-05",
        merchantRaw: "Coffee",
        categorySource: "plaid",
      }, 4),
    ]);

    const vm = buildAccountViewModel({
      snapshot,
      nowIso: "2026-09-05T12:00:00.000Z",
      connections: [{ itemId: "item-1", status: "ready" }],
    });

    expect(vm.groups.map((group) => group.title)).toEqual(["Connected bank", "Manual accounts"]);
    expect(vm.groups[0]?.accounts).toHaveLength(2);
    expect(vm.groups[0]?.connectionStatusLabel).toBe("Connected");
    expect(vm.groups[0]?.canDisconnect).toBe(true);
    expect(vm.groups[0]?.accounts[0]).toMatchObject({
      accountId: "bank-checking",
      maskLabel: "•••• 1234",
      spendingCapacityFormatted: "$1,200.00",
      transactionCount: 1,
      ageLabel: "updated 1h ago",
    });
    expect(vm.groups[1]?.accounts[0]).toMatchObject({
      accountId: "manual-cash",
      balanceFormatted: "$50.00",
      balanceBasisLabel: "Based on your entries",
    });
  });

  it("shows an importing connection before its first account arrives", () => {
    const vm = buildAccountViewModel({
      snapshot: buildSnapshot([]),
      nowIso: "2026-09-05T12:00:00.000Z",
      connections: [{ itemId: "item-new", status: "importing" }],
    });
    expect(vm).toMatchObject({
      accountCount: 0,
      groups: [
        {
          connectionId: "item-new",
          connectionStatusLabel: "Importing account data",
          canDisconnect: true,
          accounts: [],
        },
      ],
    });
  });
});
