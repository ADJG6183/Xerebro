/**
 * "Can I buy this?" end-to-end against the real server app, exercising the
 * exact behaviors verificationEngine.md specifies: manual-account freshness
 * exemption, the refresh-race with timeout fallback, uncertainty labeling,
 * and the RecommendationRecorded/FeedbackSubmitted audit trail.
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
import { InMemoryOutbox } from "../src/data/outbox";
import type { SyncTransport } from "../src/data/syncClient";
import { pushUserEvents } from "../src/data/syncClient";
import {
  enhanceExplanation,
  runPurchaseCheck,
  submitFeedback,
  type DecisionFlowDeps,
} from "../src/data/decisionFlow";
import {
  accountUpserted,
  billUpserted,
  bucketUpserted,
  manualTransaction,
  type EventFactoryDeps,
} from "../src/data/userEvents";

const NOW = "2026-07-07T10:00:00.000Z";

async function makeServer() {
  let n = 0;
  let authN = 0;
  const deps: AppDeps = {
    plaid: {
      async transactionsSync() {
        throw new Error("not scripted");
      },
    },
    events: new InMemoryEventStore(),
    items: new InMemoryItemStore(),
    registry: new InMemoryTxnRegistry(),
    now: () => NOW,
    newEventId: () => `srv-${++n}`,
    webhookVerifier: DEV_TRUST_ALL_VERIFIER,
    // Deterministic ids: first registration = user-1/device-1, matching the
    // ids tests use when seeding the event store directly.
    auth: new InMemoryAuthStore({
      now: () => NOW,
      newId: () => (++authN % 2 === 1 ? `user-${(authN + 1) / 2}` : `device-${authN / 2}`),
    }),
  };
  return { deps, app: await buildApp(deps) };
}

/** Registers lazily on first use; every call carries the bearer token. */
function injectTransport(app: Awaited<ReturnType<typeof buildApp>>): SyncTransport {
  let tokenPromise: Promise<string> | null = null;
  const token = () =>
    (tokenPromise ??= app
      .inject({ method: "POST", url: "/auth/register", payload: { deviceName: "test" } })
      .then((r) => (r.json() as { accessToken: string }).accessToken));
  return {
    async getEventsSince(since) {
      const res = await app.inject({
        method: "GET",
        url: `/events?since=${since}`,
        headers: { authorization: `Bearer ${await token()}` },
      });
      if (res.statusCode !== 200) throw new Error(`pull ${res.statusCode}`);
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

function factory(deviceId: string): EventFactoryDeps {
  let n = 0;
  return { newId: () => `${deviceId}-${++n}`, nowIso: () => NOW, deviceId };
}

async function seedManualAccount(flow: DecisionFlowDeps, openingMinor = 500_000) {
  await pushUserEvents(flow.transport, flow.log, [
    accountUpserted(flow.factory, {
      accountId: "manual-checking",
      type: "checking",
      source: "manual",
      name: "My Checking",
      currency: "USD",
      balanceCurrentMinor: 0,
      balanceAsOf: "2026-07-01T00:00:00.000Z", // days old — must NOT matter (manual exemption)
      status: "active",
      openingBalanceMinor: openingMinor,
    }),
    manualTransaction(flow.factory, {
      txnId: "t-rent",
      accountId: "manual-checking",
      amountMinor: -120_000,
      currency: "USD",
      status: "posted",
      postedDate: "2026-07-05",
      merchantRaw: "Rent",
      categorySource: "user",
    }),
  ]);
}

function makeFlow(transport: SyncTransport): DecisionFlowDeps {
  return {
    log: new InMemoryDeviceLog(),
    outbox: new InMemoryOutbox(),
    transport,
    factory: factory("device-a"),
    userId: "user-1",
    refreshTimeoutMs: 50,
  };
}

describe("runPurchaseCheck", () => {
  it("uses queued offline expenses in the same financial picture as the dashboard", async () => {
    const { app } = await makeServer();
    const flow = makeFlow(injectTransport(app));
    await pushUserEvents(flow.transport, flow.log, [
      accountUpserted(flow.factory, {
        accountId: "manual-checking",
        type: "checking",
        source: "manual",
        name: "My Checking",
        currency: "USD",
        balanceCurrentMinor: 100_000,
        balanceAsOf: NOW,
        status: "active",
        openingBalanceMinor: 100_000,
      }),
    ]);
    await flow.outbox.enqueue([
      manualTransaction(flow.factory, {
        txnId: "queued-expense",
        accountId: "manual-checking",
        amountMinor: -80_000,
        currency: "USD",
        status: "posted",
        postedDate: "2026-07-07",
        merchantRaw: "Queued expense",
        categorySource: "user",
      }),
    ]);

    const result = await runPurchaseCheck(flow, 40_000);

    expect(result.record.decision.inputsSnapshot.availableCashMinor).toBe(20_000);
    expect(result.record.decision.decision).toBe("decline");
  });

  it("uses queued buckets and bills in purchase decisions", async () => {
    const { app } = await makeServer();
    const flow = makeFlow(injectTransport(app));
    await pushUserEvents(flow.transport, flow.log, [
      accountUpserted(flow.factory, {
        accountId: "manual-checking",
        type: "checking",
        source: "manual",
        name: "My Checking",
        currency: "USD",
        balanceCurrentMinor: 100_000,
        balanceAsOf: NOW,
        status: "active",
        openingBalanceMinor: 100_000,
      }),
    ]);
    await flow.outbox.enqueue([
      bucketUpserted(flow.factory, {
        bucketId: "emergency",
        name: "Emergency fund",
        allocatedMinor: 30_000,
      }),
      billUpserted(flow.factory, {
        billId: "rent",
        name: "Rent",
        expectedAmountMinor: 40_000,
        nextDue: "2026-07-20",
      }),
    ]);

    const result = await runPurchaseCheck(flow, 40_000);

    expect(result.record.decision.inputsSnapshot.availableCashMinor).toBe(70_000);
    expect(result.record.decision.inputsSnapshot.upcomingObligationsMinor).toBe(40_000);
    expect(result.record.decision.decision).toBe("decline");
  });

  it("manual-only state is freshness-exempt: VERIFIED despite week-old entry timestamps", async () => {
    const { app, deps } = await makeServer();
    const flow = makeFlow(injectTransport(app));
    await seedManualAccount(flow); // $5,000 − $1,200 = $3,800 available

    const result = await runPurchaseCheck(flow, 60_000, "flight"); // $600

    expect(result.record.verification.status).toBe("VERIFIED");
    expect(result.record.decision.decision).toBe("approve");
    expect(result.manualDataOnly).toBe(true);
    expect(result.explanation).toMatch(/^Yes — you can afford the flight \(\$600\.00\)/);
    expect(result.record.decision.inputsSnapshot.description).toBe("flight"); // audit keeps the context
    expect(result.recordStatus).toBe("synced");

    // The audit record reached the server log, reconstructable by retrieval.
    const serverEvents = await deps.events.eventsSince("user-1", 0);
    const rec = serverEvents.find((e) => e.type === "RecommendationRecorded");
    expect(rec).toBeDefined();
    const payload = rec!.payload as { decision: { rulesVersion: string }; templateExplanation: string };
    expect(payload.decision.rulesVersion).toBeTruthy();
    expect(payload.templateExplanation).toContain("Yes — you can afford");
  });

  it("stale aggregator data triggers the refresh-race; fresh balance arrives and verifies", async () => {
    const { app, deps } = await makeServer();
    const base = injectTransport(app);

    // Refresh simulates the coming balance-sync: server appends a fresh AccountUpserted.
    const transport: SyncTransport = {
      ...base,
      async refreshItem(itemId) {
        expect(itemId).toBe("item-9");
        await deps.events.appendBatch(
          "user-1",
          [
            {
              eventId: "srv-fresh-1",
              type: "AccountUpserted",
              schemaVersion: 1,
              occurredAt: NOW,
              source: "plaid",
              idempotencyKey: "refresh:item-9:1",
              payload: {
                accountId: "plaid-check",
                type: "checking",
                source: "plaid",
                name: "Bank Checking",
                currency: "USD",
                balanceCurrentMinor: 300_000,
                balanceAvailableMinor: 300_000,
                reconciliationStatus: "reconciled",
                reconciliationDriftMinor: 0,
                balanceAsOf: NOW, // fresh!
                status: "active",
                plaidItemId: "item-9",
              },
            },
          ],
          "refresh-batch-1",
        );
      },
    };
    const flow = makeFlow(transport);

    // Seed a STALE plaid account (40h old) via the server log directly.
    await deps.events.appendBatch(
      "user-1",
      [
        {
          eventId: "srv-stale-1",
          type: "AccountUpserted",
          schemaVersion: 1,
          occurredAt: NOW,
          source: "plaid",
          idempotencyKey: "seed:plaid-check",
          payload: {
            accountId: "plaid-check",
            type: "checking",
            source: "plaid",
            name: "Bank Checking",
            currency: "USD",
            balanceCurrentMinor: 300_000,
            balanceAvailableMinor: 300_000,
            reconciliationStatus: "reconciled",
            reconciliationDriftMinor: 0,
            balanceAsOf: "2026-07-05T18:00:00.000Z", // ~40h before NOW
            status: "active",
            plaidItemId: "item-9",
          },
        },
      ],
      "seed-batch",
    );

    const result = await runPurchaseCheck(flow, 60_000);
    expect(result.record.verification.status).toBe("VERIFIED"); // refresh won the race
    expect(result.record.verification.dataAgeSeconds).toBe(0);
    expect(result.manualDataOnly).toBe(false);
  });

  it("a fresh bank balance remains CANT_VERIFY until reconciliation is established", async () => {
    const { app, deps } = await makeServer();
    const flow = makeFlow(injectTransport(app));
    await deps.events.appendBatch(
      "user-1",
      [
        {
          eventId: "srv-fresh-unreconciled",
          type: "AccountUpserted",
          schemaVersion: 1,
          occurredAt: NOW,
          source: "plaid",
          idempotencyKey: "seed:fresh-unreconciled",
          payload: {
            accountId: "plaid-unreconciled",
            type: "checking",
            source: "plaid",
            name: "Bank Checking",
            currency: "USD",
            balanceCurrentMinor: 300_000,
            balanceAvailableMinor: 295_000,
            balanceAsOf: NOW,
            status: "active",
            plaidItemId: "item-10",
            reconciliationStatus: "unknown",
          },
        },
      ],
      "seed-unreconciled",
    );

    const result = await runPurchaseCheck(flow, 60_000);

    expect(result.record.verification.status).toBe("CANT_VERIFY");
    expect(result.record.verification.boundedBy).toBe("reconciliation");
    expect(result.record.verification.reason).toContain("not established");
    expect(result.record.decision.inputsSnapshot.availableCashMinor).toBe(295_000);
  });

  it("refresh timeout → CANT_VERIFY: answer renders, labeled, never fabricated", async () => {
    const { app, deps } = await makeServer();
    const base = injectTransport(app);
    const transport: SyncTransport = {
      ...base,
      refreshItem: () => new Promise(() => {}), // hangs forever; 50ms timeout wins
    };
    const flow = makeFlow(transport);

    await deps.events.appendBatch(
      "user-1",
      [
        {
          eventId: "srv-stale-2",
          type: "AccountUpserted",
          schemaVersion: 1,
          occurredAt: NOW,
          source: "plaid",
          idempotencyKey: "seed:plaid-2",
          payload: {
            accountId: "plaid-check",
            type: "checking",
            source: "plaid",
            name: "Bank Checking",
            currency: "USD",
            balanceCurrentMinor: 300_000,
            balanceAvailableMinor: 300_000,
            balanceAsOf: "2026-07-05T18:00:00.000Z",
            status: "active",
            plaidItemId: "item-9",
          },
        },
      ],
      "seed-batch-2",
    );

    const result = await runPurchaseCheck(flow, 60_000);
    expect(result.record.verification.status).toBe("CANT_VERIFY");
    expect(result.explanation).toContain("can't verify");
    expect(result.explanation).toContain("40h ago");
    expect(result.record.decision.decision).toBeTruthy(); // decision still computed
    expect(result.recordStatus).toBe("synced"); // CANT_VERIFY answers are audited too
  });

  it("a stalled initial pull does not hang the purchase check: bounded, falls back to local cache", async () => {
    const { app } = await makeServer();
    const base = injectTransport(app);
    const flow = makeFlow(base);
    // Seed through the working transport so the device log genuinely has
    // the account before the hang is introduced.
    await seedManualAccount(flow);
    // Now swap in a transport whose FIRST pull hangs forever — the purchase
    // check must still bound its wait and fall back to the (already-seeded)
    // cache. Only the first call hangs: runPurchaseCheck's own audit-record
    // write also pulls internally (syncClient.ts's flushOutbox), on a path
    // this slice does NOT bound (tracked as a known gap) — hanging that one
    // too would make this test time out on an unrelated, already-flagged
    // limitation instead of proving the thing it's actually testing.
    let pullCalls = 0;
    flow.transport = {
      ...base,
      getEventsSince: (since) => {
        pullCalls += 1;
        return pullCalls === 1 ? new Promise(() => {}) : base.getEventsSince(since);
      },
    };

    const started = Date.now();
    const result = await runPurchaseCheck(flow, 1_000);
    // Generous wall-clock ceiling: proves the unbounded await is gone, without
    // coupling the test to the exact internal timeout value.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.offline).toBe(true);
    expect(result.record.decision.decision).toBeTruthy(); // still computed from local cache
  });

  it("submitFeedback lands a FeedbackSubmitted event in the server log", async () => {
    const { app, deps } = await makeServer();
    const flow = makeFlow(injectTransport(app));
    await seedManualAccount(flow);
    const result = await runPurchaseCheck(flow, 60_000);

    expect(await submitFeedback(flow, result.record.recommendationId, "accepted")).toBe(true);

    const events = await deps.events.eventsSince("user-1", 0);
    const feedback = events.find((e) => e.type === "FeedbackSubmitted");
    expect(feedback?.payload).toMatchObject({
      recommendationId: result.record.recommendationId,
      response: "accepted",
    });
  });

  it("beat 2: faithful LLM text upgrades the prose and lands an amendment event", async () => {
    const { app, deps } = await makeServer();
    const base = injectTransport(app);
    const transport: SyncTransport = {
      ...base,
      async getExplanation() {
        return {
          text: "Yes — the flight at $600.00 fits your plans comfortably.",
          provider: "openai",
          model: "test-model",
          promptTemplateVersion: "tmpl-v1",
        };
      },
    };
    const flow = makeFlow(transport);
    await seedManualAccount(flow);

    const result = await runPurchaseCheck(flow, 60_000, "flight");
    const better = await enhanceExplanation(flow, result.record);

    expect(better?.text).toContain("fits your plans");
    const events = await deps.events.eventsSince("user-1", 0);
    const amendment = events.find((e) => e.type === "RecommendationExplanationAdded");
    expect(amendment?.payload).toMatchObject({
      recommendationId: result.record.recommendationId,
      llm: { provider: "openai", explanationTextVerbatim: better!.text },
    });
  });

  it("beat 2: unfaithful LLM text is rejected ON DEVICE — no upgrade, no amendment", async () => {
    const { app, deps } = await makeServer();
    const base = injectTransport(app);
    const transport: SyncTransport = {
      ...base,
      async getExplanation() {
        return {
          text: "Yes — $600.00 is fine; similar flights cost $89.99 on Tuesdays.",
          provider: "openai",
          model: "test-model",
          promptTemplateVersion: "tmpl-v1",
        };
      },
    };
    const flow = makeFlow(transport);
    await seedManualAccount(flow);

    const result = await runPurchaseCheck(flow, 60_000, "flight");
    expect(await enhanceExplanation(flow, result.record)).toBeNull();

    const events = await deps.events.eventsSince("user-1", 0);
    expect(events.find((e) => e.type === "RecommendationExplanationAdded")).toBeUndefined();
  });

  it("beat 2: proxy absent or failing → null; the template stands", async () => {
    const { app } = await makeServer();
    const flow = makeFlow(injectTransport(app)); // no getExplanation on transport
    await seedManualAccount(flow);
    const result = await runPurchaseCheck(flow, 60_000);
    expect(await enhanceExplanation(flow, result.record)).toBeNull();

    const failing = makeFlow({
      ...injectTransport(app),
      getExplanation: async () => {
        throw new Error("503");
      },
    });
    expect(await enhanceExplanation(failing, result.record)).toBeNull();
  });

  it("decline path: buffer math shows in the explanation", async () => {
    const { app } = await makeServer();
    const flow = makeFlow(injectTransport(app));
    await seedManualAccount(flow, 130_000); // $1,300 − $1,200 rent = $100 available

    const result = await runPurchaseCheck(flow, 60_000); // $600 purchase, $500 short
    expect(result.record.decision.decision).toBe("decline");
    expect(result.explanation).toContain("$500.00 short");
  });
});
