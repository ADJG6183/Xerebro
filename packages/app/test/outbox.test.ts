/**
 * The offline write path end-to-end: actions taken with no network are
 * durable, render optimistically, flush idempotently when the network
 * returns, and end up byte-identical to actions taken online.
 */
import { describe, expect, it } from "vitest";
import {
  buildApp,
  DEV_TRUST_ALL_VERIFIER,
  InMemoryEventStore,
  InMemoryItemStore,
  InMemoryTxnRegistry,
  type AppDeps,
  InMemoryAuthStore,
} from "@xerebro/server";
import type { EventEnvelope } from "@xerebro/engines";
import { buildDashboardViewModel } from "../src/data/dashboardModel";
import { InMemoryDeviceLog } from "../src/data/deviceLog";
import { runPurchaseCheck, type DecisionFlowDeps } from "../src/data/decisionFlow";
import { InMemoryOutbox, withPending } from "../src/data/outbox";
import { flushOutbox, sendOrQueue, type SyncTransport } from "../src/data/syncClient";
import { accountUpserted, manualTransaction, type EventFactoryDeps } from "../src/data/userEvents";

const NOW = "2026-07-10T10:00:00.000Z";
const TODAY = "2026-07-10";

async function makeServer() {
  let n = 0;
  const deps: AppDeps = {
    plaid: { transactionsSync: async () => { throw new Error("unused"); } },
    events: new InMemoryEventStore(),
    items: new InMemoryItemStore(),
    registry: new InMemoryTxnRegistry(),
    now: () => NOW,
    newEventId: () => `srv-${++n}`,
    webhookVerifier: DEV_TRUST_ALL_VERIFIER,
    auth: new InMemoryAuthStore({
      now: () => NOW,
      newId: (() => { let a = 0; return () => (++a % 2 === 1 ? `user-${(a + 1) / 2}` : `device-${a / 2}`); })(),
    }),
  };
  return { deps, app: await buildApp(deps) };
}

/** Transport with a network switch: offline() throws on every call. */
function switchableTransport(app: Awaited<ReturnType<typeof buildApp>>) {
  let online = true;
  let tokenPromise: Promise<string> | null = null;
  const token = () =>
    (tokenPromise ??= app
      .inject({ method: "POST", url: "/auth/register", payload: {} })
      .then((r) => (r.json() as { accessToken: string }).accessToken));
  const transport: SyncTransport = {
    async getEventsSince(since) {
      if (!online) throw new Error("network down");
      const res = await app.inject({
        method: "GET",
        url: `/events?since=${since}`,
        headers: { authorization: `Bearer ${await token()}` },
      });
      return res.json() as { events: EventEnvelope[]; lastSequence: number };
    },
    async postEvents(events) {
      if (!online) throw new Error("network down");
      const res = await app.inject({
        method: "POST",
        url: "/events",
        payload: { events },
        headers: { authorization: `Bearer ${await token()}` },
      });
      if (res.statusCode !== 200) throw new Error(`push ${res.statusCode}`);
    },
  };
  return { transport, setOnline: (v: boolean) => (online = v) };
}

function factory(deviceId: string): EventFactoryDeps {
  let n = 0;
  return { newId: () => `${deviceId}-${++n}`, nowIso: () => NOW, deviceId };
}

function demoEvents(deps: EventFactoryDeps) {
  return [
    accountUpserted(deps, {
      accountId: "manual-checking",
      type: "checking",
      source: "manual",
      name: "My Checking",
      currency: "USD",
      balanceCurrentMinor: 0,
      balanceAsOf: NOW,
      status: "active",
      openingBalanceMinor: 500_000,
    }),
    manualTransaction(deps, {
      txnId: "t-coffee",
      accountId: "manual-checking",
      amountMinor: -450,
      currency: "USD",
      status: "posted",
      postedDate: TODAY,
      merchantRaw: "Coffee Shop",
      categorySource: "user",
    }),
  ];
}

describe("offline outbox", () => {
  it("serializes concurrent flush triggers for the same queue", async () => {
    const { app } = await makeServer();
    const { transport } = switchableTransport(app);
    const log = new InMemoryDeviceLog();
    const outbox = new InMemoryOutbox();
    await outbox.enqueue(demoEvents(factory("device-a")));
    let posts = 0;
    const counted: SyncTransport = {
      ...transport,
      async postEvents(events) {
        posts += 1;
        await transport.postEvents(events);
      },
    };

    const results = await Promise.all([
      flushOutbox(counted, log, outbox),
      flushOutbox(counted, log, outbox),
    ]);

    expect(posts).toBe(1);
    expect(results.map((result) => result.flushed).sort((a, b) => a - b)).toEqual([0, 2]);
    expect(await outbox.size()).toBe(0);
  });

  it("keeps uploaded actions queued until their server copies are downloaded", async () => {
    const { app, deps: server } = await makeServer();
    const { transport } = switchableTransport(app);
    const log = new InMemoryDeviceLog();
    const outbox = new InMemoryOutbox();
    const uploadWorksButDownloadFails: SyncTransport = {
      ...transport,
      async getEventsSince() {
        throw new Error("download failed");
      },
    };

    const first = await sendOrQueue(
      uploadWorksButDownloadFails,
      log,
      outbox,
      demoEvents(factory("device-a")),
    );

    expect(first.status).toBe("queued");
    expect(await outbox.size()).toBe(2);
    expect(await log.all()).toHaveLength(0);
    expect(await server.events.lastSequence("user-1")).toBe(2);

    const recovered = await flushOutbox(transport, log, outbox);
    expect(recovered).toEqual({ flushed: 2, pending: 0 });
    expect((await log.all()).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("offline action → queued + optimistic dashboard; reconnect → flush → server parity", async () => {
    const { app, deps: server } = await makeServer();
    const { transport, setOnline } = switchableTransport(app);
    const log = new InMemoryDeviceLog();
    const outbox = new InMemoryOutbox();

    setOnline(false); // ✂ no network
    const result = await sendOrQueue(transport, log, outbox, demoEvents(factory("device-a")));
    expect(result.status).toBe("queued");
    expect(await outbox.size()).toBe(2);
    expect(await server.events.lastSequence("user-1")).toBe(0); // nothing reached the server

    // Optimistic view: the dashboard already shows the account and the coffee.
    const optimistic = buildDashboardViewModel({
      events: withPending(await log.all(), await outbox.all()),
      todayLocal: TODAY,
      nowIso: NOW,
    });
    expect(optimistic.hasAccounts).toBe(true);
    expect(optimistic.availableCashFormatted).toBe("$4,995.50");

    setOnline(true); // network returns
    const flush = await flushOutbox(transport, log, outbox);
    expect(flush).toEqual({ flushed: 2, pending: 0 });
    expect(await outbox.size()).toBe(0);

    // Server now has the events with REAL sequences; device log pulled them.
    expect(await server.events.lastSequence("user-1")).toBe(2);
    const synced = buildDashboardViewModel({
      events: withPending(await log.all(), await outbox.all()),
      todayLocal: TODAY,
      nowIso: NOW,
    });
    expect(synced.availableCashFormatted).toBe(optimistic.availableCashFormatted); // identical numbers
  });

  it("ambiguous failure (server applied, response lost) → flush retry does NOT duplicate", async () => {
    const { app, deps: server } = await makeServer();
    const { transport } = switchableTransport(app);
    const log = new InMemoryDeviceLog();
    const outbox = new InMemoryOutbox();

    // postEvents succeeds server-side but the response "gets lost".
    const flaky: SyncTransport = {
      ...transport,
      async postEvents(events) {
        await transport.postEvents(events);
        throw new Error("connection reset while reading response");
      },
    };

    const first = await sendOrQueue(flaky, log, outbox, demoEvents(factory("device-a")));
    expect(first.status).toBe("queued"); // device thinks it failed…
    expect(await server.events.lastSequence("user-1")).toBe(2); // …server applied it

    const flush = await flushOutbox(transport, log, outbox); // healthy retry
    expect(flush.pending).toBe(0);
    expect(await server.events.lastSequence("user-1")).toBe(2); // idempotency keys: no duplicates
    expect((await log.all()).map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("a stalled flush does not block the caller: queued within the bound, event still durable", async () => {
    const { app } = await makeServer();
    const { transport } = switchableTransport(app);
    const log = new InMemoryDeviceLog();
    const outbox = new InMemoryOutbox();

    // postEvents succeeds, but the download leg (inside flushOutbox's own
    // pullOnce) hangs forever — simulating a half-dead connection, not an
    // outright failure.
    const halfDead: SyncTransport = { ...transport, getEventsSince: () => new Promise(() => {}) };

    const started = Date.now();
    const result = await sendOrQueue(halfDead, log, outbox, demoEvents(factory("device-a")), 50);
    expect(Date.now() - started).toBeLessThan(1_000); // bounded, not however long the hang lasts
    expect(result.status).toBe("queued");
    expect(await outbox.size()).toBe(2); // still durable locally — nothing lost
  });

  it("purchase check fully offline: verdict renders, audit record queued, flush lands it", async () => {
    const { app, deps: server } = await makeServer();
    const { transport, setOnline } = switchableTransport(app);
    const flow: DecisionFlowDeps = {
      log: new InMemoryDeviceLog(),
      outbox: new InMemoryOutbox(),
      transport,
      factory: factory("device-a"),
      userId: "user-1",
      refreshTimeoutMs: 50,
    };

    // Seed while online so the device has state, then cut the cord.
    await sendOrQueue(transport, flow.log, flow.outbox, demoEvents(flow.factory));
    setOnline(false);

    const result = await runPurchaseCheck(flow, 60_000, "headphones");
    expect(result.record.decision.decision).toBe("approve"); // deterministic, fully local
    expect(result.offline).toBe(true);
    expect(result.recordStatus).toBe("queued");
    expect(result.explanation).toContain("the headphones ($600.00)");

    setOnline(true);
    await flushOutbox(transport, flow.log, flow.outbox);
    const rec = (await server.events.eventsSince("user-1", 0)).find(
      (e) => e.type === "RecommendationRecorded",
    );
    expect(rec).toBeDefined(); // the offline answer made it into the audit trail
  });

  it("outbox preserves FIFO order and ignores duplicate enqueues", async () => {
    const outbox = new InMemoryOutbox();
    const deps = factory("device-a");
    const events = demoEvents(deps);
    await outbox.enqueue(events);
    await outbox.enqueue(events); // re-tap
    expect(await outbox.size()).toBe(2);
    expect((await outbox.all()).map((e) => e.idempotencyKey)).toEqual(
      events.map((e) => e.idempotencyKey),
    );
  });

  it("gives separate account edits separate retry identities", () => {
    const deps = factory("device-a");
    const account = {
      accountId: "manual-checking",
      type: "checking" as const,
      source: "manual" as const,
      name: "My Checking",
      currency: "USD",
      balanceCurrentMinor: 0,
      balanceAsOf: NOW,
      status: "active" as const,
      openingBalanceMinor: 500_000,
    };

    const firstEdit = accountUpserted(deps, account);
    const laterEditBackToSameValues = accountUpserted(deps, account);

    expect(laterEditBackToSameValues.idempotencyKey).not.toBe(firstEdit.idempotencyKey);
  });
});
