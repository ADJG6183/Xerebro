/**
 * The point of the manual-entry milestone, proven end-to-end: buckets and
 * bills a user types in are the SAME numbers the decision engine reads. Add a
 * bill, and "Can I buy this?" changes its mind — through the real server, the
 * real sync/outbox path, and the real engines fold.
 */
import { describe, expect, it } from "vitest";
import {
  buildApp,
  DEV_TRUST_ALL_VERIFIER,
  InMemoryAuthStore,
  InMemoryEventStore,
  InMemoryItemStore,
  InMemoryTxnRegistry,
  type AppDeps,
} from "@xerebro/server";
import type { EventEnvelope } from "@xerebro/engines";
import { InMemoryDeviceLog } from "../src/data/deviceLog";
import { InMemoryOutbox } from "../src/data/outbox";
import { runPurchaseCheck, type DecisionFlowDeps } from "../src/data/decisionFlow";
import { sendOrQueue, type SyncTransport } from "../src/data/syncClient";
import {
  accountUpserted,
  billUpserted,
  bucketUpserted,
  type EventFactoryDeps,
} from "../src/data/userEvents";

const NOW = "2026-07-12T10:00:00.000Z";

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

function injectTransport(app: Awaited<ReturnType<typeof buildApp>>): SyncTransport {
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
      return res.json() as { events: EventEnvelope[]; lastSequence: number };
    },
    async postEvents(events) {
      const res = await app.inject({
        method: "POST",
        url: "/events",
        payload: { events },
        headers: { authorization: `Bearer ${await token()}` },
      });
      if (res.statusCode !== 200) throw new Error(`push ${res.statusCode}`);
    },
  };
}

function factory(): EventFactoryDeps {
  let n = 0;
  return { newId: () => `dev-${++n}`, nowIso: () => NOW, deviceId: "device-a" };
}

function makeFlow(transport: SyncTransport): DecisionFlowDeps {
  return {
    log: new InMemoryDeviceLog(),
    outbox: new InMemoryOutbox(),
    transport,
    factory: factory(),
    userId: "user-1",
    refreshTimeoutMs: 50,
  };
}

describe("manual entry feeds the decision engine", () => {
  it("adding a large bill flips a $600 purchase from approve to decline", async () => {
    const { app } = await makeServer();
    const transport = injectTransport(app);
    const flow = makeFlow(transport);

    // $5,000 in a manual account. $600 purchase easily clears the $500 floor.
    await sendOrQueue(transport, flow.log, flow.outbox, [
      accountUpserted(flow.factory, {
        accountId: "acc-1",
        type: "checking",
        source: "manual",
        name: "Checking",
        currency: "USD",
        balanceCurrentMinor: 500_000,
        balanceAsOf: NOW,
        status: "active",
        openingBalanceMinor: 500_000,
      }),
    ]);

    const before = await runPurchaseCheck(flow, 60_000, "flight");
    expect(before.record.decision.decision).toBe("approve");

    // Now the user records a $4,600 bill due next week.
    await sendOrQueue(transport, flow.log, flow.outbox, [
      billUpserted(flow.factory, {
        billId: "bill-1",
        name: "Insurance",
        expectedAmountMinor: 460_000,
        nextDue: "2026-07-18",
      }),
    ]);

    const after = await runPurchaseCheck(flow, 60_000, "flight");
    // $5,000 − $4,600 bill − $600 purchase = −$200: a shortfall.
    expect(after.record.decision.decision).toBe("decline");
    expect(after.record.decision.inputsSnapshot.upcomingObligationsMinor).toBe(460_000);
  });

  it("a bucket allocation reduces available cash the decision sees", async () => {
    const { app } = await makeServer();
    const transport = injectTransport(app);
    const flow = makeFlow(transport);

    await sendOrQueue(transport, flow.log, flow.outbox, [
      accountUpserted(flow.factory, {
        accountId: "acc-1",
        type: "checking",
        source: "manual",
        name: "Checking",
        currency: "USD",
        balanceCurrentMinor: 100_000,
        balanceAsOf: NOW,
        status: "active",
        openingBalanceMinor: 100_000,
      }),
      bucketUpserted(flow.factory, {
        bucketId: "buck-1",
        name: "Emergency",
        allocatedMinor: 80_000, // reserves $800 of the $1,000
      }),
    ]);

    const result = await runPurchaseCheck(flow, 60_000, "flight");
    // Only $200 is spendable after the bucket → $600 purchase declines.
    expect(result.record.decision.inputsSnapshot.availableCashMinor).toBe(20_000);
    expect(result.record.decision.decision).toBe("decline");
  });
});
