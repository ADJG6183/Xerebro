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
  PostgresLinkTokenOwners,
  PostgresPlaidConnectionLifecycleStore,
  PostgresPlaidIngestionStore,
  PostgresPlaidJobStore,
  PostgresTxnRegistry,
} from "../src/persistence/postgres";
import { authStoreContract } from "./authContract";
import { eventStoreContract, itemStoreContract } from "./storeContract";
import { reviewAccountHistory } from "../src/accountContinuity";

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
      appendBatch: (u, e, b, s) => inner.appendBatch(prefix + u, e, b, s),
      eventsSince: (u, s, l) => inner.eventsSince(prefix + u, s, l),
      lastSequence: (u) => inner.lastSequence(prefix + u),
    };
  });

  // Same namespacing trick: unique item ids per run so repeated runs against
  // a live database don't collide.
  let itemN = 0;
  itemStoreContract("postgres", async () => {
    const inner = new PostgresItemStore(createPoolLazy());
    const prefix = `${runId}-${++itemN}:`;
    return {
      get: (id) => inner.get(prefix + id),
      listForUser: (u) => inner.listForUser(u),
      put: (item) => inner.put({ ...item, itemId: prefix + item.itemId }),
      setCursor: (id, c) => inner.setCursor(prefix + id, c),
      setStatus: (id, s, e) => inner.setStatus(prefix + id, s, e),
      markDisconnected: (id) => inner.markDisconnected(prefix + id),
    };
  });

  function createPoolLazy(): pg.Pool {
    return pool;
  }

  it("serializes competing history matches through the real event-store transaction", async () => {
    const events = new PostgresEventStore(pool);
    const userId = randomUUID();
    const now = () => "2026-09-12T12:00:00Z";
    const rows = [
      ["AccountUpserted", { accountId: "old", source: "plaid", type: "checking", name: "Old", currency: "USD", status: "disconnected", balanceCurrentMinor: 10000, balanceAsOf: now() }],
      ["AccountUpserted", { accountId: "new", source: "plaid", type: "checking", name: "New", currency: "USD", status: "active", balanceCurrentMinor: 10000, balanceAsOf: now() }],
      ["AccountContinuitySet", { accountId: "new", decision: "pending", candidates: [{ accountId: "old" }] }],
      ...["original", "a", "b"].map((txnId) => ["TransactionPosted", { txnId, accountId: txnId === "original" ? "old" : "new", amountMinor: -500,
        currency: "USD", status: "posted", postedDate: "2026-09-10", merchantRaw: "Coffee", categorySource: "plaid" }]),
    ] as const;
    await events.appendBatch(userId, rows.map(([type, payload]) => ({ type: type as string, payload, eventId: randomUUID(), idempotencyKey: randomUUID(), occurredAt: now(), source: "system" as const, schemaVersion: 1 })), "seed");
    const deps = { events, now, newEventId: randomUUID };
    await reviewAccountHistory(deps, userId, { kind: "account", commandId: "identity", accountId: "new", decision: "same", predecessorId: "old", expectedVersion: 3, timeZone: "America/New_York" });
    const results = await Promise.allSettled(["a", "b"].map((txnId, i) => reviewAccountHistory(deps, userId, {
      kind: "transaction", commandId: txnId, txnId, expectedVersion: 5 + i, continuityVersion: 7, decision: "duplicate", originalTxnId: "original",
    })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await events.lastSequence(userId)).toBe(8);
  });

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
      status: "ready",
    });
    await expect(items.setCursor(`${runId}-ghost`, "x")).rejects.toThrow(/unknown plaid item/);
  });

  it("persists Link ownership across store instances without storing the raw token", async () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    const token = `${runId}-secret-link-token`;
    await new PostgresLinkTokenOwners(pool, () => now).remember(token, `${runId}-owner`);
    expect(await new PostgresLinkTokenOwners(pool, () => now).ownerOf(token)).toBe(
      `${runId}-owner`,
    );
    const raw = await pool.query(`SELECT 1 FROM plaid_link_token_owners WHERE token_hash = $1`, [token]);
    expect(raw.rowCount).toBe(0);
  });

  it("atomically stores a new connection with its first import job", async () => {
    const itemId = `${runId}-lifecycle-item`;
    const lifecycle = new PostgresPlaidConnectionLifecycleStore(pool);
    const jobs = new PostgresPlaidJobStore(pool);
    await lifecycle.startConnection(
      { itemId, userId: `${runId}-user`, accessTokenRef: "sealed", cursor: "" },
      "2026-09-12T12:00:00.000Z",
    );
    expect(await new PostgresItemStore(pool).get(itemId)).toMatchObject({ status: "importing" });
    expect(await jobs.getForItem(itemId, "sync")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("leases one Plaid job to only one concurrent worker", async () => {
    const itemId = `${runId}-lease-item`;
    const userId = `${runId}-lease-user`;
    const items = new PostgresItemStore(pool);
    const jobs = new PostgresPlaidJobStore(pool);
    await items.put({ itemId, userId, accessTokenRef: "sealed", cursor: "" });
    await jobs.enqueue(itemId, userId, "sync", "2026-09-12T12:00:00.000Z");
    const claims = await Promise.all([
      jobs.claim(itemId, "sync", "2026-09-12T12:00:00.000Z", "2026-09-12T12:01:00.000Z"),
      jobs.claim(itemId, "sync", "2026-09-12T12:00:00.000Z", "2026-09-12T12:01:00.000Z"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
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

  it("atomically commits a Plaid update and rejects a stale concurrent cursor", async () => {
    const userId = `${runId}-ingest-user`;
    const itemId = `${runId}-ingest-item`;
    const items = new PostgresItemStore(pool);
    const ingestion = new PostgresPlaidIngestionStore(pool);
    const events = new PostgresEventStore(pool);
    await items.put({ itemId, userId, accessTokenRef: "sealed", cursor: "" });

    const event = {
      eventId: `${runId}-event-1`,
      type: "TransactionPosted",
      schemaVersion: 1,
      occurredAt: "2026-09-05T12:00:00.000Z",
      source: "plaid" as const,
      idempotencyKey: `${runId}-key-1`,
      payload: { txnId: "txn-1" },
    };
    const [first, stale] = await Promise.all([
      ingestion.commit({
        itemId,
        userId,
        expectedCursor: "",
        nextCursor: "c1",
        events: [event],
        knownTxnIds: ["txn-1"],
        aliases: [{ plaidId: "posted-1", canonicalId: "txn-1" }],
      }),
      ingestion.commit({
        itemId,
        userId,
        expectedCursor: "",
        nextCursor: "c2",
        events: [{ ...event, eventId: `${runId}-event-2`, idempotencyKey: `${runId}-key-2` }],
        knownTxnIds: ["txn-2"],
        aliases: [],
      }),
    ]);

    expect([first.committed, stale.committed].filter(Boolean)).toHaveLength(1);
    expect(await events.eventsSince(userId, 0)).toHaveLength(1);
    expect(["c1", "c2"]).toContain((await items.get(itemId))?.cursor);
  });

  it("rolls back events, registry writes, and cursor together on failure", async () => {
    const userId = `${runId}-rollback-user`;
    const itemId = `${runId}-rollback-item`;
    const items = new PostgresItemStore(pool);
    const ingestion = new PostgresPlaidIngestionStore(pool);
    const events = new PostgresEventStore(pool);
    const registry = new PostgresTxnRegistry(pool);
    await items.put({ itemId, userId, accessTokenRef: "sealed", cursor: "" });

    await expect(
      ingestion.commit({
        itemId,
        userId,
        expectedCursor: "",
        nextCursor: "c1",
        events: [
          {
            eventId: `${runId}-rollback-event`,
            type: "TransactionPosted",
            schemaVersion: 1,
            occurredAt: "2026-09-05T12:00:00.000Z",
            source: "plaid",
            idempotencyKey: `${runId}-rollback-key`,
            payload: { txnId: "rollback-txn" },
          },
        ],
        knownTxnIds: ["rollback-txn"],
        aliases: [{ plaidId: "bad-alias", canonicalId: null } as unknown as {
          plaidId: string;
          canonicalId: string;
        }],
      }),
    ).rejects.toThrow();

    expect(await events.eventsSince(userId, 0)).toEqual([]);
    expect(await registry.has(userId, "rollback-txn")).toBe(false);
    expect((await items.get(itemId))?.cursor).toBe("");
  });
});
