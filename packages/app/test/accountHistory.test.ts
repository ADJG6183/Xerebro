import { describe, expect, it } from "vitest";
import { buildSnapshot, dispatchTool, type EventEnvelope } from "@xerebro/engines";
import { buildAccountViewModel } from "../src/data/accountModel";
import { buildDashboardViewModel } from "../src/data/dashboardModel";
import { InMemoryDeviceLog } from "../src/data/deviceLog";
import { InMemoryOutbox } from "../src/data/outbox";
import { runPurchaseCheck } from "../src/data/decisionFlow";

const now = "2026-09-12T12:00:00Z";
const event = (type: string, payload: unknown, sequence: number): EventEnvelope => ({
  eventId: `e-${sequence}`, idempotencyKey: `k-${sequence}`, type, payload, sequence, occurredAt: now, source: "system", schemaVersion: 1,
});
const events = [
  event("AccountUpserted", { accountId: "old", source: "plaid", type: "checking", name: "Original", currency: "USD", balanceCurrentMinor: 90000, balanceAsOf: now, status: "disconnected", plaidItemId: "old-item" }, 1),
  event("AccountUpserted", { accountId: "new", source: "plaid", type: "checking", name: "Reconnected", currency: "USD", balanceCurrentMinor: 100000, balanceAvailableMinor: 100000, balanceAsOf: now, status: "active", plaidItemId: "new-item", reconciliationStatus: "reconciled", reconciliationDriftMinor: 0 }, 2),
  event("AccountContinuitySet", { accountId: "new", decision: "same", candidates: [{ accountId: "old" }], predecessorId: "old", cutoffDate: "2026-09-12" }, 3),
  event("TransactionPosted", { txnId: "original", accountId: "old", amountMinor: -500, currency: "USD", status: "posted", postedDate: "2026-09-12", merchantRaw: "Coffee", categorySource: "plaid" }, 4),
  event("TransactionPosted", { txnId: "repeat", accountId: "new", amountMinor: -500, currency: "USD", status: "posted", postedDate: "2026-09-12", merchantRaw: "Coffee", categorySource: "plaid" }, 5),
];

describe("account history across app surfaces", () => {
  it("shows overlap and suggestions offline while dashboard and copilot count the original once", () => {
    const snapshot = buildSnapshot(events);
    const accounts = buildAccountViewModel({ snapshot, nowIso: now });
    const row = accounts.groups.flatMap((g) => g.accounts).find((a) => a.accountId === "new")!;
    expect(row.transactionCount).toBe(1);
    expect(row.history?.transactions[0]).toMatchObject({ txnId: "repeat", statusLabel: "Not counted — needs review", candidates: [{ txnId: "original" }] });
    const dashboard = buildDashboardViewModel({ snapshot, todayLocal: "2026-09-12", nowIso: now });
    expect(dashboard.expensesThisMonthFormatted).toBe("$5.00");
    expect(dashboard.availableCashFormatted).toBe("$1,000.00");
    expect(dashboard.balanceWarning).toContain("history is incomplete");
    expect(dashboard.transactionGroups.flatMap((g) => g.items).find((t) => t.txnId === "repeat")?.merchant).toContain("Needs review");
    const result = dispatchTool("spend_total", events, { fromDate: "2026-09-01", toDate: "2026-09-30" }, { todayLocal: "2026-09-12" });
    expect(result.figures).toEqual([500]);
    expect(result.data.warning).toContain("history is incomplete");
  });

  it("withholds verified purchase approval despite fresh reconciled cash when overlap is unresolved", async () => {
    const log = new InMemoryDeviceLog(); await log.append(events);
    let id = 0;
    const result = await runPurchaseCheck({ log, outbox: new InMemoryOutbox(), userId: "user-1",
      factory: { newId: () => `review-test-${++id}`, nowIso: () => now, deviceId: "test-device" },
      transport: { getEventsSince: async () => ({ events: [], lastSequence: 5 }), postEvents: async () => { throw new Error("offline"); } },
    }, 1000);
    expect(result.record.verification.status).toBe("CANT_VERIFY");
    expect(result.record.verification.reason).toContain("history is incomplete");
  });
});
