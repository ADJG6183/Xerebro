/**
 * Full-spine tests: REAL server (fastify inject, in-memory stores) ↔ device
 * sync client ↔ engines fold ↔ dashboard view-model. No network, no mocks of
 * our own code — only the seams (Plaid, HTTP wire) are faked.
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
import { InMemoryDeviceLog } from "../src/data/deviceLog";
import { pullOnce, pushUserEvents, type SyncTransport } from "../src/data/syncClient";
import { buildDashboardViewModel } from "../src/data/dashboardModel";
import { accountUpserted, manualTransaction, type EventFactoryDeps } from "../src/data/userEvents";

function makeServer(): { deps: AppDeps; app: ReturnType<typeof buildApp> } {
  let n = 0;
  const deps: AppDeps = {
    plaid: {
      async transactionsSync() {
        throw new Error("not used in this test");
      },
    },
    events: new InMemoryEventStore(),
    items: new InMemoryItemStore(),
    registry: new InMemoryTxnRegistry(),
    now: () => "2026-07-07T12:00:00.000Z",
    newEventId: () => `srv-evt-${++n}`,
    webhookVerifier: DEV_TRUST_ALL_VERIFIER,
    auth: new InMemoryAuthStore({
      now: () => "2026-07-07T12:00:00.000Z",
      newId: (() => { let a = 0; return () => (++a % 2 === 1 ? `user-${(a + 1) / 2}` : `device-${a / 2}`); })(),
    }),
  };
  return { deps, app: buildApp(deps) };
}

/** The app's SyncTransport driven through the real HTTP layer via inject.
 * Registers lazily; every call carries the bearer token. */
function injectTransport(app: ReturnType<typeof buildApp>): SyncTransport {
  let tokenPromise: Promise<string> | null = null;
  const token = () =>
    (tokenPromise ??= app
      .inject({ method: "POST", url: "/auth/register", payload: {} })
      .then((r) => (r.json() as { accessToken: string }).accessToken));
  return {
    async getEventsSince(since) {
      const res = await app.inject({
        method: "GET",
        url: `/events?since=${since}`,
        headers: { authorization: `Bearer ${await token()}` },
      });
      if (res.statusCode !== 200) throw new Error(`pull failed: ${res.statusCode}`);
      return res.json() as { events: EventEnvelope[]; lastSequence: number };
    },
    async postEvents(events) {
      const res = await app.inject({
        method: "POST",
        url: "/events",
        payload: { events },
        headers: { authorization: `Bearer ${await token()}` },
      });
      if (res.statusCode !== 200) throw new Error(`push failed: ${res.statusCode}`);
    },
  };
}

function factory(deviceId: string): EventFactoryDeps {
  let n = 0;
  return { newId: () => `${deviceId}-evt-${++n}`, nowIso: () => "2026-07-07T08:00:00.000Z", deviceId };
}

const NOW = "2026-07-07T10:00:00.000Z";
const TODAY = "2026-07-07";

function demoEvents(deps: EventFactoryDeps) {
  return [
    accountUpserted(deps, {
      accountId: "manual-checking",
      type: "checking",
      source: "manual",
      name: "My Checking",
      currency: "USD",
      balanceCurrentMinor: 0,
      balanceAsOf: "2026-07-07T08:00:00.000Z",
      status: "active",
      openingBalanceMinor: 500_000,
    }),
    manualTransaction(deps, {
      txnId: "t-groceries",
      accountId: "manual-checking",
      amountMinor: -6_842,
      currency: "USD",
      status: "posted",
      postedDate: TODAY,
      merchantRaw: "Grocery Store",
      category: "Groceries",
      categorySource: "user",
    }),
    manualTransaction(deps, {
      txnId: "t-salary",
      accountId: "manual-checking",
      amountMinor: 240_000,
      currency: "USD",
      status: "posted",
      postedDate: TODAY,
      merchantRaw: "Salary",
      category: "Income",
      categorySource: "user",
    }),
  ];
}

describe("device ↔ server sync spine", () => {
  it("push from phone A, pull on phone B: both compute the IDENTICAL dashboard", async () => {
    const { app } = makeServer();
    const transport = injectTransport(app);

    const phoneA = new InMemoryDeviceLog();
    await pushUserEvents(transport, phoneA, demoEvents(factory("device-a")));

    const phoneB = new InMemoryDeviceLog(); // fresh install, second device
    await pullOnce(transport, phoneB);

    const vmA = buildDashboardViewModel({ events: await phoneA.all(), todayLocal: TODAY, nowIso: NOW });
    const vmB = buildDashboardViewModel({ events: await phoneB.all(), todayLocal: TODAY, nowIso: NOW });

    expect(vmA).toEqual(vmB); // same log, same numbers — multi-device determinism
    expect(vmA.availableCashFormatted).toBe("$7,331.58"); // 5,000 − 68.42 + 2,400
    expect(vmA.dataAgeLabel).toBe("as of 2h ago");
    // Same posted date → newest server sequence first (Salary was pushed last).
    expect(vmA.recentTransactions.map((t) => t.merchant)).toEqual(["Salary", "Grocery Store"]);
  });

  it("re-pushing after a dropped connection appends nothing (producer idempotency)", async () => {
    const { app, deps } = makeServer();
    const transport = injectTransport(app);
    const phone = new InMemoryDeviceLog();

    const events = demoEvents(factory("device-a"));
    await pushUserEvents(transport, phone, events);
    await pushUserEvents(transport, phone, events); // retry, same actionKeys

    expect(await deps.events.lastSequence("user-1")).toBe(3);
    expect(await phone.lastSequence()).toBe(3);
  });

  it("pull is paginated and catches up in one call", async () => {
    const { app } = makeServer();
    const transport = injectTransport(app);
    const seeder = new InMemoryDeviceLog();

    // Seed 7 manual transactions through the real push path.
    const deps = factory("device-a");
    const txns = Array.from({ length: 7 }, (_, i) =>
      manualTransaction(deps, {
        txnId: `bulk-${i}`,
        accountId: "manual-checking",
        amountMinor: -100 * (i + 1),
        currency: "USD",
        status: "posted",
        postedDate: TODAY,
        merchantRaw: `M${i}`,
        categorySource: "user",
      }),
    );
    await pushUserEvents(transport, seeder, txns);

    // A page-size-2 transport wrapper proves the pull loop drains everything.
    const paged: SyncTransport = {
      async getEventsSince(since) {
        const full = await transport.getEventsSince(since);
        return { ...full, events: full.events.slice(0, 2) };
      },
      postEvents: transport.postEvents,
    };

    const phone = new InMemoryDeviceLog();
    const result = await pullOnce(paged, phone);
    expect(result.pulled).toBe(7);
    expect(await phone.lastSequence()).toBe(7);
  });

  it("appending the same synced page twice is harmless (device-side idempotency)", async () => {
    const phone = new InMemoryDeviceLog();
    const event = {
      eventId: "e-1",
      sequence: 1,
      type: "TransactionPosted",
      schemaVersion: 1,
      occurredAt: NOW,
      source: "user",
      idempotencyKey: "k-1",
      payload: {},
    } as EventEnvelope;
    await phone.append([event]);
    await phone.append([event]);
    expect((await phone.all()).length).toBe(1);
  });
});
