/**
 * THE store contract: every EventStore implementation must pass these,
 * identically. The in-memory store is the spec; adapters (Postgres) conform.
 * Called from eventStore.test.ts (always, in-memory) and persistence.test.ts
 * (against a live Postgres when TEST_DATABASE_URL is set).
 */
import { describe, expect, it } from "vitest";
import type { EventStore, UnsequencedEvent } from "../src/eventStore";

function event(n: number, key?: string): UnsequencedEvent {
  return {
    eventId: `evt-${n}`,
    type: "TransactionPosted",
    schemaVersion: 1,
    occurredAt: "2026-07-08T10:00:00.000Z",
    source: "user",
    idempotencyKey: key ?? `idem-${n}`,
    payload: { n },
  };
}

export function eventStoreContract(name: string, make: () => Promise<EventStore>) {
  describe(`EventStore contract: ${name}`, () => {
    it("assigns gapless per-user sequences starting at 1", async () => {
      const store = await make();
      const a = await store.appendBatch("u1", [event(1), event(2)], "b1");
      const b = await store.appendBatch("u1", [event(3)], "b2");
      expect(a.appended.map((e) => e.sequence)).toEqual([1, 2]);
      expect(b.appended.map((e) => e.sequence)).toEqual([3]);
      expect(await store.lastSequence("u1")).toBe(3);
    });

    it("isolates users: sequences and reads never bleed across user ids", async () => {
      const store = await make();
      await store.appendBatch("u1", [event(1)], "b1");
      const other = await store.appendBatch("u2", [event(2)], "b1"); // same batch key, other user
      expect(other.appended[0]?.sequence).toBe(1);
      expect(await store.eventsSince("u1", 0)).toHaveLength(1);
      expect((await store.eventsSince("u2", 0))[0]?.payload).toEqual({ n: 2 });
    });

    it("replaying a batch key is a full no-op", async () => {
      const store = await make();
      await store.appendBatch("u1", [event(1)], "plaid:item:cursor");
      const replay = await store.appendBatch("u1", [event(9, "idem-other")], "plaid:item:cursor");
      expect(replay).toEqual({ appended: [], deduped: true });
      expect(await store.lastSequence("u1")).toBe(1);
    });

    it("duplicate producer idempotency keys are skipped WITHOUT burning a sequence", async () => {
      const store = await make();
      await store.appendBatch("u1", [event(1, "K")], "b1");
      const second = await store.appendBatch("u1", [event(2, "K"), event(3)], "b2");
      expect(second.appended).toHaveLength(1); // only event 3
      expect(second.appended[0]?.sequence).toBe(2); // gapless: no hole for the dupe
      const all = await store.eventsSince("u1", 0);
      expect(all.map((e) => e.sequence)).toEqual([1, 2]);
    });

    it("eventsSince pages by sequence with a limit, preserving payloads verbatim", async () => {
      const store = await make();
      await store.appendBatch("u1", [event(1), event(2), event(3), event(4)], "b1");
      const page = await store.eventsSince("u1", 1, 2);
      expect(page.map((e) => e.sequence)).toEqual([2, 3]);
      expect(page[0]?.payload).toEqual({ n: 2 });
      expect(page[0]?.occurredAt).toBe("2026-07-08T10:00:00.000Z");
      expect(await store.eventsSince("u1", 4)).toEqual([]);
    });

    it("concurrent appends for one user stay gapless (the FOR UPDATE guarantee)", async () => {
      const store = await make();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.appendBatch("u1", [event(i)], `batch-${i}`),
        ),
      );
      const all = await store.eventsSince("u1", 0);
      expect(all.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  });
}
