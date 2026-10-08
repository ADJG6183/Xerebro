import { describe, expect, it } from "vitest";
import { InMemoryEventStore, type UnsequencedEvent } from "../src/eventStore";
import {
  InMemoryItemStore,
  InMemoryPlaidIngestionStore,
  InMemoryTxnRegistry,
} from "../src/plaid/stores";

function event(id: string): UnsequencedEvent {
  return {
    eventId: id,
    type: "TransactionPosted",
    schemaVersion: 1,
    occurredAt: "2026-09-05T12:00:00.000Z",
    source: "plaid",
    idempotencyKey: `plaid:${id}`,
    payload: { txnId: id },
  };
}

describe("atomic Plaid ingestion store", () => {
  it("commits events, identities, aliases, and cursor as one result", async () => {
    const events = new InMemoryEventStore();
    const items = new InMemoryItemStore();
    const registry = new InMemoryTxnRegistry();
    const ingestion = new InMemoryPlaidIngestionStore(events, items, registry);
    await items.put({ itemId: "item-1", userId: "user-1", accessTokenRef: "sealed", cursor: "c0" });

    const result = await ingestion.commit({
      itemId: "item-1",
      userId: "user-1",
      expectedCursor: "c0",
      nextCursor: "c1",
      events: [event("t1")],
      knownTxnIds: ["t1"],
      aliases: [{ plaidId: "posted-1", canonicalId: "t1" }],
    });

    expect(result).toEqual({ committed: true, appended: 1 });
    expect((await items.get("item-1"))?.cursor).toBe("c1");
    expect(await events.lastSequence("user-1")).toBe(1);
    expect(await registry.has("user-1", "t1")).toBe(true);
    expect(await registry.aliasFor("user-1", "posted-1")).toBe("t1");
  });

  it("allows only one concurrent commit from the same starting cursor", async () => {
    const events = new InMemoryEventStore();
    const items = new InMemoryItemStore();
    const registry = new InMemoryTxnRegistry();
    const ingestion = new InMemoryPlaidIngestionStore(events, items, registry);
    await items.put({ itemId: "item-1", userId: "user-1", accessTokenRef: "sealed", cursor: "c0" });
    const base = {
      itemId: "item-1",
      userId: "user-1",
      expectedCursor: "c0",
      knownTxnIds: [] as string[],
      aliases: [] as { plaidId: string; canonicalId: string }[],
    };

    const results = await Promise.all([
      ingestion.commit({ ...base, nextCursor: "c1", events: [event("winner-a")] }),
      ingestion.commit({ ...base, nextCursor: "c2", events: [event("winner-b")] }),
    ]);

    expect(results.filter((result) => result.committed)).toHaveLength(1);
    expect(await events.lastSequence("user-1")).toBe(1);
  });
});
