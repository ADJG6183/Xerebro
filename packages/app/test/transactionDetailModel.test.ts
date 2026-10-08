import { buildSnapshot, type EventEnvelope } from "@xerebro/engines";
import { describe, expect, it } from "vitest";
import { buildTransactionDetail } from "../src/data/transactionDetailModel";
import {
  accountUpserted,
  manualTransaction,
  transactionAnnotated,
  type EventFactoryDeps,
} from "../src/data/userEvents";

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

const ACCOUNT = accountUpserted(deps, {
  accountId: "acct-1",
  type: "checking",
  source: "manual",
  name: "My Checking",
  currency: "USD",
  balanceCurrentMinor: 0,
  balanceAsOf: "2026-07-07T08:00:00.000Z",
  status: "active",
  openingBalanceMinor: 500_000,
});

const TXN = manualTransaction(deps, {
  txnId: "t-1",
  accountId: "acct-1",
  amountMinor: -4_250,
  currency: "USD",
  status: "posted",
  postedDate: "2026-07-05",
  merchantRaw: "UBER   063015 SF**POOL**",
  category: "TRANSPORTATION",
  categorySource: "user",
});

describe("buildTransactionDetail", () => {
  it("returns null for an unknown id", () => {
    const snapshot = buildSnapshot(sequenced([ACCOUNT, TXN]));
    expect(buildTransactionDetail(snapshot, "nope")).toBeNull();
  });

  it("surfaces amount, account, dates, status, category, and the raw description untouched", () => {
    const snapshot = buildSnapshot(sequenced([ACCOUNT, TXN]));
    const detail = buildTransactionDetail(snapshot, "t-1");
    expect(detail).toMatchObject({
      txnId: "t-1",
      amountFormatted: "-$42.50",
      isInflow: false,
      currency: "USD",
      accountId: "acct-1",
      accountName: "My Checking",
      status: "posted",
      postedDate: "2026-07-05",
      category: "TRANSPORTATION",
      merchantRaw: "UBER   063015 SF**POOL**",
      removed: false,
    });
    expect(detail?.note).toBeUndefined();
  });

  it("a category/note correction overrides the effective category without touching the source", () => {
    const snapshot = buildSnapshot(
      sequenced([ACCOUNT, TXN, transactionAnnotated(deps, { txnId: "t-1", categoryOverride: "FOOD", note: "split with Sam" })]),
    );
    const detail = buildTransactionDetail(snapshot, "t-1");
    expect(detail?.category).toBe("FOOD"); // effective, overlaid
    expect(detail?.note).toBe("split with Sam");
    // The raw source fact is untouched by the correction.
    expect(detail?.merchantRaw).toBe("UBER   063015 SF**POOL**");
  });

  it("a removed transaction is still findable, labeled, and keeps its removal reason", () => {
    const removal: Omit<EventEnvelope, "sequence"> = {
      eventId: "ev-remove",
      type: "TransactionRemoved",
      schemaVersion: 1,
      occurredAt: "2026-07-06T00:00:00.000Z",
      source: "plaid",
      idempotencyKey: "remove:t-1",
      payload: { txnId: "t-1", reason: "pending hold never posted" },
    };
    const snapshot = buildSnapshot(sequenced([ACCOUNT, TXN, removal]));
    const detail = buildTransactionDetail(snapshot, "t-1");
    expect(detail?.removed).toBe(true);
    expect(detail?.removedReason).toBe("pending hold never posted");
  });
});
