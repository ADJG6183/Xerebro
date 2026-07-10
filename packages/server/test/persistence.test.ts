/**
 * Postgres adapter tests — run only when TEST_DATABASE_URL points at a live
 * database (npm run db:up -w @xerebro/server, then
 * TEST_DATABASE_URL=postgres://xerebro:xerebro_dev@localhost:5433/xerebro).
 * Each run uses fresh random user/item ids, so reruns don't collide.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  createPool,
  ensureSchema,
  PostgresAuthStore,
  PostgresEventStore,
  PostgresItemStore,
  PostgresTxnRegistry,
} from "../src/persistence/postgres";
import { authStoreContract } from "./authContract";
import { eventStoreContract } from "./storeContract";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("postgres persistence", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(url!);
    await ensureSchema(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  // The same contract the in-memory reference passes — with per-run user
  // isolation via a store wrapper that prefixes user ids.
  const runId = `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let n = 0;
  eventStoreContract("postgres", async () => {
    const inner = new PostgresEventStore(createPoolLazy());
    const prefix = `${runId}-${++n}:`;
    return {
      appendBatch: (u, e, b) => inner.appendBatch(prefix + u, e, b),
      eventsSince: (u, s, l) => inner.eventsSince(prefix + u, s, l),
      lastSequence: (u) => inner.lastSequence(prefix + u),
    };
  });

  function createPoolLazy(): pg.Pool {
    return pool;
  }

  authStoreContract(
    "postgres",
    async () =>
      new PostgresAuthStore(createPoolLazy(), {
        now: () => new Date().toISOString(),
        newId: () => randomUUID(),
      }),
  );

  it("ItemStore round-trips and updates cursors", async () => {
    const items = new PostgresItemStore(pool);
    const itemId = `${runId}-item`;
    await items.put({ itemId, userId: "u", accessTokenRef: "ref-1", cursor: "" });
    await items.setCursor(itemId, "c42");
    expect(await items.get(itemId)).toEqual({
      itemId,
      userId: "u",
      accessTokenRef: "ref-1",
      cursor: "c42",
    });
    await expect(items.setCursor(`${runId}-ghost`, "x")).rejects.toThrow(/unknown plaid item/);
  });

  it("TxnRegistry tracks canonical ids and aliases", async () => {
    const reg = new PostgresTxnRegistry(pool);
    const u = `${runId}-reg`;
    expect(await reg.has(u, "t1")).toBe(false);
    await reg.add(u, "t1");
    expect(await reg.has(u, "t1")).toBe(true);
    await reg.addAlias(u, "posted-9", "t1");
    expect(await reg.aliasFor(u, "posted-9")).toBe("t1");
    expect(await reg.aliasFor(u, "nope")).toBeUndefined();
  });

  it("events survive across store instances (the whole point: durability)", async () => {
    const u = `${runId}-durable`;
    const a = new PostgresEventStore(pool);
    await a.appendBatch(
      u,
      [
        {
          eventId: "e1",
          type: "AccountUpserted",
          schemaVersion: 1,
          occurredAt: "2026-07-08T10:00:00.000Z",
          source: "user",
          idempotencyKey: "k1",
          payload: { accountId: "a1" },
        },
      ],
      "b1",
    );
    const b = new PostgresEventStore(pool); // "new process"
    const events = await b.eventsSince(u, 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ accountId: "a1" });
  });
});
