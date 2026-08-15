/**
 * The cache-safety invariant (ADR-003): a materialized snapshot advanced
 * incrementally must be IDENTICAL to one rebuilt from the whole log. If that
 * ever fails, the dashboard would show numbers that depend on when you
 * happened to open the app — so this is the load-bearing test of the whole
 * optimization.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  advanceSnapshot,
  buildSnapshot,
  emptySnapshot,
  type ProjectionSnapshot,
} from "../src/projection/snapshot";
import type { EventEnvelope } from "../src/events";
import { arbEventLog, posted } from "./helpers";

/** Comparable form: Maps/Sets → sorted plain data. */
function plain(s: ProjectionSnapshot) {
  return {
    transactions: Object.fromEntries([...s.transactions.transactions.entries()].sort()),
    annotations: Object.fromEntries([...s.transactions.annotations.entries()].sort()),
    warnings: [...s.transactions.warnings],
    accounts: [...s.accounts].sort((a, b) => a.accountId.localeCompare(b.accountId)),
    buckets: [...s.buckets].sort((a, b) => a.bucketId.localeCompare(b.bucketId)),
    bills: [...s.bills].sort((a, b) => a.billId.localeCompare(b.billId)),
    lastSequence: s.lastSequence,
  };
}

/** Non-transaction events, built directly (the typed `envelope` helper in
 * helpers.ts is scoped to the transaction catalog). */
const userEvent = (type: string, payload: unknown, sequence: number): EventEnvelope => ({
  eventId: `${type}-${sequence}`,
  sequence,
  type,
  schemaVersion: 1,
  occurredAt: "2026-07-12T00:00:00.000Z",
  source: "user",
  idempotencyKey: `${type}-${sequence}`,
  payload,
});

const account = (id: string, opening: number, sequence: number) =>
  userEvent(
    "AccountUpserted",
    {
      accountId: id,
      type: "checking",
      source: "manual",
      name: id,
      currency: "USD",
      balanceCurrentMinor: 0,
      balanceAsOf: "2026-07-12T00:00:00.000Z",
      status: "active",
      openingBalanceMinor: opening,
    },
    sequence,
  );

const bucket = (id: string, allocated: number, sequence: number) =>
  userEvent("BucketUpserted", { bucketId: id, name: id, allocatedMinor: allocated }, sequence);

const bill = (id: string, amount: number, due: string, sequence: number) =>
  userEvent("BillUpserted", { billId: id, name: id, expectedAmountMinor: amount, nextDue: due }, sequence);

describe("materialized projection snapshot", () => {
  it("PROPERTY: advancing event-by-event === rebuilding from the whole log", () => {
    fc.assert(
      fc.property(arbEventLog, (events) => {
        const rebuilt = buildSnapshot(events);
        const incremental = events.reduce(
          (snap, event) => advanceSnapshot(snap, [event]),
          emptySnapshot(),
        );
        expect(plain(incremental)).toEqual(plain(rebuilt));
      }),
    );
  });

  it("PROPERTY: any split point gives the same result (resume from any sequence)", () => {
    fc.assert(
      fc.property(arbEventLog, fc.nat(), (events, seed) => {
        const split = events.length === 0 ? 0 : seed % (events.length + 1);
        const twoStep = advanceSnapshot(
          advanceSnapshot(emptySnapshot(), events.slice(0, split)),
          events.slice(split),
        );
        expect(plain(twoStep)).toEqual(plain(buildSnapshot(events)));
      }),
    );
  });

  it("PROPERTY: re-feeding already-applied events changes nothing (idempotent)", () => {
    fc.assert(
      fc.property(arbEventLog, (events) => {
        const once = buildSnapshot(events);
        const again = advanceSnapshot(once, events);
        expect(plain(again)).toEqual(plain(once));
        expect(again).toBe(once); // same object: no wasted work
      }),
    );
  });

  it("advances accounts, buckets and bills with last-write-wins", () => {
    const base = buildSnapshot([
      account("acct-1", 500_000, 1),
      bucket("b-1", 10_000, 2),
      bill("bill-1", 7_430, "2026-07-20", 3),
    ]);
    expect(base.accounts).toHaveLength(1);
    expect(base.buckets[0]?.allocatedMinor).toBe(10_000);

    const next = advanceSnapshot(base, [
      bucket("b-1", 25_000, 4), // edit
      bucket("b-2", 5_000, 5), // new
    ]);
    expect(next.buckets).toHaveLength(2);
    expect(next.buckets.find((b) => b.bucketId === "b-1")?.allocatedMinor).toBe(25_000);
    expect(next.lastSequence).toBe(5);
    expect(base.buckets[0]?.allocatedMinor).toBe(10_000); // original untouched
  });

  it("folds transactions incrementally, matching a full rebuild", () => {
    const events = [posted("t-1", -1_000, 1), posted("t-2", -2_500, 2)] as EventEnvelope[];
    const incremental = advanceSnapshot(advanceSnapshot(emptySnapshot(), [events[0]!]), [events[1]!]);
    expect(plain(incremental)).toEqual(plain(buildSnapshot(events)));
    expect(incremental.transactions.transactions.size).toBe(2);
  });

  it("ignores stale events below the snapshot sequence", () => {
    const snap = buildSnapshot([posted("t-1", -1_000, 5)]);
    const withStale = advanceSnapshot(snap, [posted("t-old", -999, 2)]);
    expect(withStale).toBe(snap); // nothing applied
    expect(withStale.transactions.transactions.has("t-old")).toBe(false);
  });
});
