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
} from "@xerebro/server";
import type { EventEnvelope } from "@xerebro/engines";
import { InMemoryDeviceLog } from "../src/data/deviceLog";
import type { SyncTransport } from "../src/data/syncClient";
import { pushUserEvents } from "../src/data/syncClient";
import {
  enhanceExplanation,
  runPurchaseCheck,
  submitFeedback,
  type DecisionFlowDeps,
} from "../src/data/decisionFlow";
import { accountUpserted, manualTransaction, type EventFactoryDeps } from "../src/data/userEvents";

const NOW = "2026-07-07T10:00:00.000Z";

function makeServer() {
  let n = 0;
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
  };
  return { deps, app: buildApp(deps) };
}

function injectTransport(app: ReturnType<typeof buildApp>): SyncTransport {
  return {
    async getEventsSince(userId, since) {
      const res = await app.inject({ method: "GET", url: `/events?userId=${userId}&since=${since}` });
      if (res.statusCode !== 200) throw new Error(`pull ${res.statusCode}`);
      return res.json() as { events: EventEnvelope[]; lastSequence: number };
    },
    async postEvents(userId, events) {
      const res = await app.inject({ method: "POST", url: "/events", payload: { userId, events } });
      if (res.statusCode !== 200) throw new Error(`push ${res.statusCode}`);
    },
  };
}

function factory(deviceId: string): EventFactoryDeps {
  let n = 0;
  return { newId: () => `${deviceId}-${++n}`, nowIso: () => NOW, deviceId };
}

async function seedManualAccount(flow: DecisionFlowDeps, openingMinor = 500_000) {
  await pushUserEvents(flow.transport, flow.log, flow.userId, [
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
    transport,
    factory: factory("device-a"),
    userId: "user-1",
    refreshTimeoutMs: 50,
  };
}

describe("runPurchaseCheck", () => {
  it("manual-only state is freshness-exempt: VERIFIED despite week-old entry timestamps", async () => {
    const { app, deps } = makeServer();
    const flow = makeFlow(injectTransport(app));
    await seedManualAccount(flow); // $5,000 − $1,200 = $3,800 available

    const result = await runPurchaseCheck(flow, 60_000, "flight"); // $600

    expect(result.record.verification.status).toBe("VERIFIED");
    expect(result.record.decision.decision).toBe("approve");
    expect(result.manualDataOnly).toBe(true);
    expect(result.explanation).toMatch(/^Yes — you can afford the flight \(\$600\.00\)/);
    expect(result.record.decision.inputsSnapshot.description).toBe("flight"); // audit keeps the context
    expect(result.recordPersisted).toBe(true);

    // The audit record reached the server log, reconstructable by retrieval.
    const serverEvents = await deps.events.eventsSince("user-1", 0);
    const rec = serverEvents.find((e) => e.type === "RecommendationRecorded");
    expect(rec).toBeDefined();
    const payload = rec!.payload as { decision: { rulesVersion: string }; templateExplanation: string };
    expect(payload.decision.rulesVersion).toBeTruthy();
    expect(payload.templateExplanation).toContain("Yes — you can afford");
  });

  it("stale aggregator data triggers the refresh-race; fresh balance arrives and verifies", async () => {
    const { app, deps } = makeServer();
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

  it("refresh timeout → CANT_VERIFY: answer renders, labeled, never fabricated", async () => {
    const { app, deps } = makeServer();
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
    expect(result.recordPersisted).toBe(true); // CANT_VERIFY answers are audited too
  });

  it("submitFeedback lands a FeedbackSubmitted event in the server log", async () => {
    const { app, deps } = makeServer();
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
    const { app, deps } = makeServer();
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
    const { app, deps } = makeServer();
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
    const { app } = makeServer();
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
    const { app } = makeServer();
    const flow = makeFlow(injectTransport(app));
    await seedManualAccount(flow, 130_000); // $1,300 − $1,200 rent = $100 available

    const result = await runPurchaseCheck(flow, 60_000); // $600 purchase, $500 short
    expect(result.record.decision.decision).toBe("decline");
    expect(result.explanation).toContain("$500.00 short");
  });
});
