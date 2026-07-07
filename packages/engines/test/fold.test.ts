import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyEvent,
  applyEvents,
  effectiveTransactions,
  emptyProjection,
} from "../src/projection/transactions";
import { arbEventLog, envelope, posted, projectionToPlain } from "./helpers";

describe("transaction fold (ADR-003 reference implementation)", () => {
  it("PROPERTY: folding the same log twice yields identical projections", () => {
    fc.assert(
      fc.property(arbEventLog, (events) => {
        const a = applyEvents(emptyProjection(), events);
        const b = applyEvents(emptyProjection(), events);
        expect(projectionToPlain(a)).toEqual(projectionToPlain(b));
      }),
    );
  });

  it("PROPERTY: incremental fold equals batch fold (rebuild-from-log guarantee)", () => {
    fc.assert(
      fc.property(arbEventLog, fc.nat(), (events, splitSeed) => {
        const split = events.length === 0 ? 0 : splitSeed % (events.length + 1);
        const batch = applyEvents(emptyProjection(), events);
        const incremental = applyEvents(
          applyEvents(emptyProjection(), events.slice(0, split)),
          events.slice(split),
        );
        expect(projectionToPlain(incremental)).toEqual(projectionToPlain(batch));
      }),
    );
  });

  it("PROPERTY: re-applying any already-applied event is a no-op (idempotency)", () => {
    fc.assert(
      fc.property(arbEventLog, fc.nat(), (events, pickSeed) => {
        fc.pre(events.length > 0);
        const pick = events[pickSeed % events.length]!;
        const once = applyEvents(emptyProjection(), events);
        const twice = applyEvent(once, pick);
        expect(projectionToPlain(twice)).toEqual(projectionToPlain(once));
      }),
    );
  });

  it("removal is a tombstone, never a delete (append-only invariant)", () => {
    const events = [
      posted("txn-hold", -15_000, 1, { status: "pending" }),
      envelope("TransactionRemoved", { txnId: "txn-hold", reason: "hold released" }, 2),
    ] as Parameters<typeof applyEvents>[1];
    const projection = applyEvents(emptyProjection(), events);

    const row = projection.transactions.get("txn-hold");
    expect(row?.removed).toBe(true);
    expect(row?.removedReason).toBe("hold released");
    expect(effectiveTransactions(projection)).toHaveLength(0);
    expect(effectiveTransactions(projection, { includeRemoved: true })).toHaveLength(1);
  });

  it("user annotation survives an upstream TransactionUpdated (overlay invariant)", () => {
    const events = [
      posted("txn-1", -1_240, 1, { merchantRaw: "SQ *COFFEE", category: "Uncategorized" }),
      envelope("TransactionAnnotated", { txnId: "txn-1", categoryOverride: "Coffee" }, 2, "user"),
      envelope(
        "TransactionUpdated",
        { txnId: "txn-1", changes: { merchantRaw: "Blue Bottle", category: "Food & Drink" } },
        3,
      ),
    ] as Parameters<typeof applyEvents>[1];
    const projection = applyEvents(emptyProjection(), events);

    const [txn] = effectiveTransactions(projection);
    expect(txn?.merchantRaw).toBe("Blue Bottle"); // source fact updated
    expect(txn?.effectiveCategory).toBe("Coffee"); // user's correction survives
    expect(txn?.category).toBe("Food & Drink"); // upstream category still inspectable
  });

  it("events referencing unknown txnIds warn instead of throwing", () => {
    const events = [
      envelope("TransactionUpdated", { txnId: "ghost", changes: { amountMinor: -1 } }, 1),
      envelope("TransactionRemoved", { txnId: "ghost" }, 2),
    ] as Parameters<typeof applyEvents>[1];
    const projection = applyEvents(emptyProjection(), events);
    expect(projection.warnings).toHaveLength(2);
    expect(projection.transactions.size).toBe(0);
  });

  it("rejects float amounts (money invariant)", () => {
    expect(() => applyEvent(emptyProjection(), posted("txn-f", 10.5, 1))).toThrow(TypeError);
  });
});
