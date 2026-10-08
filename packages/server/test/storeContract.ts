/**
 * THE store contract: every EventStore implementation must pass these,
 * identically. The in-memory store is the spec; adapters (Postgres) conform.
 * Called from eventStore.test.ts (always, in-memory) and persistence.test.ts
 * (against a live Postgres when TEST_DATABASE_URL is set).
 */
import { describe, expect, it } from "vitest";
import type { EventStore, UnsequencedEvent } from "../src/eventStore";
import { EventSequenceConflict } from "../src/eventStore";
import type { ItemStore } from "../src/plaid/stores";

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
    it("atomically rejects stale decisions without recording their batch key", async () => {
      const store = await make();
      await store.appendBatch("u1", [event(1)], "base", 0);
      await expect(store.appendBatch("u1", [event(2)], "review", 0)).rejects.toBeInstanceOf(EventSequenceConflict);
      expect(await store.lastSequence("u1")).toBe(1);
      expect((await store.appendBatch("u1", [event(2)], "review", 1)).appended).toHaveLength(1);
      expect((await store.appendBatch("u1", [event(2)], "review", 1)).deduped).toBe(true);
    });

    it("only one concurrent decision can commit from the same snapshot", async () => {
      const store = await make();
      const results = await Promise.allSettled([
        store.appendBatch("u1", [event(1)], "a", 0),
        store.appendBatch("u1", [event(2)], "b", 0),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await store.lastSequence("u1")).toBe(1);
    });
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

    it("negative `since` means 'from the beginning' — identically in every implementation", async () => {
      const store = await make();
      await store.appendBatch("u1", [event(1), event(2), event(3)], "b1");
      const negative = await store.eventsSince("u1", -5);
      expect(negative.map((e) => e.sequence)).toEqual([1, 2, 3]);
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

/**
 * THE item store contract. The security-critical rule: an item's owner is
 * immutable, so a second user cannot take over an existing bank connection.
 */
export function itemStoreContract(name: string, make: () => Promise<ItemStore>) {
  describe(`ItemStore contract: ${name}`, () => {
    const item = {
      itemId: "item-1",
      userId: "user-a",
      accessTokenRef: "sealed-a",
      cursor: "",
    };

    it("late worker or webhook status changes cannot revive a disconnected item", async () => {
      const store = await make(); await store.put(item);
      await store.setStatus(item.itemId, "disconnecting");
      await store.setStatus(item.itemId, "ready");
      expect((await store.get(item.itemId))?.status).toBe("disconnecting");
      await store.markDisconnected(item.itemId);
      await store.setStatus(item.itemId, "retry_needed");
      expect((await store.get(item.itemId))?.status).toBe("disconnected");
    });

    it("stores an item and updates it for its owner", async () => {
      const store = await make();
      await store.put(item);
      await store.put({ ...item, accessTokenRef: "sealed-a2", cursor: "c1" });

      const stored = await store.get("item-1");
      expect(stored).toMatchObject({ userId: "user-a", accessTokenRef: "sealed-a2", cursor: "c1" });
    });

    it("SECURITY: refuses to reassign an item to another user", async () => {
      const store = await make();
      await store.put(item);
      await store.put({ ...item, userId: "user-b", accessTokenRef: "sealed-b" });

      const stored = await store.get("item-1");
      expect(stored?.userId).toBe("user-a"); // owner unchanged
      expect(stored?.accessTokenRef).toBe("sealed-a"); // and not overwritten
    });
  });
}
