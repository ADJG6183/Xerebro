import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { findMoneyViolations, validateEventPayload } from "../src/validation";
import { applyEvents, emptyProjection, effectiveTransactions } from "../src/projection/transactions";
import { foldAccounts } from "../src/projection/accounts";
import { foldBuckets } from "../src/projection/plans";
import { envelope, posted } from "./helpers";

describe("event payload validation (poison-pill defense)", () => {
  it("deep money scan: any *Minor key, at any depth, must be a safe integer", () => {
    expect(findMoneyViolations({ amountMinor: 100 })).toEqual([]);
    expect(findMoneyViolations({ amountMinor: 10.5 })[0]).toContain("amountMinor");
    expect(findMoneyViolations({ amountMinor: "100" })[0]).toContain("amountMinor");
    // Nested: an audit record smuggling a float three levels down.
    const nested = { decision: { tradeoffs: [{ code: "x", amountMinor: 0.1 + 0.2 }] } };
    expect(findMoneyViolations(nested)[0]).toContain("tradeoffs[0].amountMinor");
  });

  it("PROPERTY: no safe-integer-money payload is ever flagged by the scan", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.string(),
        (amountMinor, note) => {
          expect(findMoneyViolations({ amountMinor, nested: { note, feeMinor: amountMinor } })).toEqual([]);
        },
      ),
    );
  });

  it("structural checks catch fold-critical malformations", () => {
    expect(validateEventPayload("TransactionPosted", { txnId: "", accountId: "a", amountMinor: 1, status: "posted", merchantRaw: "m" })[0]).toContain("txnId");
    expect(validateEventPayload("TransactionUpdated", { txnId: "t", changes: null })[0]).toContain("changes");
    expect(validateEventPayload("AccountUpserted", { accountId: "a", balanceCurrentMinor: 1.5, balanceAsOf: "2026-01-01", source: "manual" })[0]).toContain("balanceCurrentMinor");
    expect(validateEventPayload("UnknownFutureType", { fine: true, costMinor: 12 })).toEqual([]);
  });
});

describe("folds survive poison already in the log", () => {
  it("a float-amount TransactionPosted is skipped with a warning — fold never throws", () => {
    const poison = posted("txn-bad", 10.5 as never, 2);
    const projection = applyEvents(emptyProjection(), [posted("txn-ok", -1_000, 1), poison]);

    expect(effectiveTransactions(projection).map((t) => t.txnId)).toEqual(["txn-ok"]);
    expect(projection.warnings.some((w) => w.includes("skipped malformed"))).toBe(true);
    expect(projection.lastSequence).toBe(2); // the log position still advances
  });

  it("a malformed TransactionUpdated cannot corrupt an existing row", () => {
    const projection = applyEvents(emptyProjection(), [
      posted("txn-ok", -1_000, 1),
      envelope("TransactionUpdated", { txnId: "txn-ok", changes: { amountMinor: "9999" } }, 2) as never,
    ]);
    expect(projection.transactions.get("txn-ok")?.amountMinor).toBe(-1_000); // untouched
    expect(projection.warnings).toHaveLength(1);
  });

  it("accounts and buckets with float money are skipped, not folded", () => {
    const poison = (type: string, payload: unknown, sequence: number) => ({
      eventId: `p-${sequence}`, sequence, type, schemaVersion: 1,
      occurredAt: "2026-07-10T00:00:00.000Z", source: "user" as const,
      idempotencyKey: `p-${sequence}`, payload,
    });
    const badAccount = poison("AccountUpserted", {
      accountId: "a1", type: "checking", source: "manual", name: "A", currency: "USD",
      balanceCurrentMinor: 0, balanceAsOf: "2026-01-01T00:00:00Z", status: "active",
      openingBalanceMinor: 100.5, // float
    }, 1);
    const badBucket = poison("BucketUpserted", { bucketId: "b1", name: "B", allocatedMinor: 0.1 }, 2);
    expect(foldAccounts([badAccount])).toEqual([]);
    expect(foldBuckets([badBucket])).toEqual([]);
  });
});
