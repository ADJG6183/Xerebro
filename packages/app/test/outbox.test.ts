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

function makeServer() {
  let n = 0;
  const deps: AppDeps = {
    plaid: { transactionsSync: async () => { throw new Error("unused"); } },
    events: new InMemoryEventStore(),
    items: new InMemoryItemStore(),
    registry: new InMemoryTxnRegistry(),
    now: () => NOW,
    newEventId: () => `srv-${++n}`,
    webhookVerifier: DEV_TRUST_ALL_VERIFIER,
  };
  return { deps, app: buildApp(deps) };
}

/** Transport with a network switch: offline() throws on every call. */
function switchableTransport(app: ReturnType<typeof buildApp>) {
  let online = true;
  const transport: SyncTransport = {
    async getEventsSince(userId, since) {
      if (!online) throw new Error("network down");
      const res = await app.inject({ method: "GET", url: `/events?userId=${userId}&since=${since}` });
      return res.json() as { events: EventEnvelope[]; lastSequence: number };
    },
    async postEvents(userId, events) {
      if (!online) throw new Error("network down");
      const res = await app.inject({ method: "POST", url: "/events", payload: { userId, events } });
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
  it("offline action → queued + optimistic dashboard; reconnect → flush → server parity", async () => {
    const { app, deps: server } = makeServer();
    const { transport, setOnline } = switchableTransport(app);
    const log = new InMemoryDeviceLog();
    const outbox = new InMemoryOutbox();

    setOnline(false); // ✂ no network
    const result = await sendOrQueue(transport, log, outbox, "user-1", demoEvents(factory("device-a")));
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
    const flush = await flushOutbox(transport, log, outbox, "user-1");
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
    const { app, deps: server } = makeServer();
    const { transport } = switchableTransport(app);
    const log = new InMemoryDeviceLog();
    const outbox = new InMemoryOutbox();

    // postEvents succeeds server-side but the response "gets lost".
    const flaky: SyncTransport = {
      ...transport,
      async postEvents(userId, events) {
        await transport.postEvents(userId, events);
        throw new Error("connection reset while reading response");
      },
    };

    const first = await sendOrQueue(flaky, log, outbox, "user-1", demoEvents(factory("device-a")));
    expect(first.status).toBe("queued"); // device thinks it failed…
    expect(await server.events.lastSequence("user-1")).toBe(2); // …server applied it

    const flush = await flushOutbox(transport, log, outbox, "user-1"); // healthy retry
    expect(flush.pending).toBe(0);
    expect(await server.events.lastSequence("user-1")).toBe(2); // idempotency keys: no duplicates
    expect((await log.all()).map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("purchase check fully offline: verdict renders, audit record queued, flush lands it", async () => {
    const { app, deps: server } = makeServer();
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
    await sendOrQueue(transport, flow.log, flow.outbox, "user-1", demoEvents(flow.factory));
    setOnline(false);

    const result = await runPurchaseCheck(flow, 60_000, "headphones");
    expect(result.record.decision.decision).toBe("approve"); // deterministic, fully local
    expect(result.offline).toBe(true);
    expect(result.recordStatus).toBe("queued");
    expect(result.explanation).toContain("the headphones ($600.00)");

    setOnline(true);
    await flushOutbox(transport, flow.log, flow.outbox, "user-1");
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
});
