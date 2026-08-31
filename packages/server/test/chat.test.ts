/**
 * Copilot orchestration, proven with a scripted gateway (no live provider):
 * routing → deterministic execution → faithful phrasing, the allowlist (raw
 * transactions never reach the model), and every degradation path (unfaithful
 * → template, out-of-scope, no provider, auth).
 */
import { describe, expect, it } from "vitest";
import { buildApp, DEV_TRUST_ALL_VERIFIER, type AppDeps } from "../src/app";
import { InMemoryAuthStore } from "../src/auth/store";
import { InMemoryEventStore, type UnsequencedEvent } from "../src/eventStore";
import { InMemoryItemStore, InMemoryTxnRegistry } from "../src/plaid/stores";
import type { LlmGateway } from "../src/llm/gateway";
import { registerHeaders } from "./helpers";

/** Gateway that routes on the first (tools) prompt and phrases on the second. */
function scriptedGateway(route: object, phrase: string): LlmGateway & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async complete({ user }) {
      prompts.push(user);
      const isRouting = user.includes('"tools"');
      return { text: isRouting ? JSON.stringify(route) : phrase, model: "test-model" };
    },
  };
}

let authN = 0;
async function appWith(llm?: LlmGateway) {
  authN = 0;
  const events = new InMemoryEventStore();
  const deps: AppDeps = {
    plaid: { transactionsSync: async () => { throw new Error("unused"); } },
    events,
    items: new InMemoryItemStore(),
    registry: new InMemoryTxnRegistry(),
    now: () => "2026-07-12T10:00:00.000Z",
    newEventId: () => "e",
    webhookVerifier: DEV_TRUST_ALL_VERIFIER,
    auth: new InMemoryAuthStore({ now: () => "2026-07-12T10:00:00.000Z", newId: () => `id-${++authN}` }),
    ...(llm ? { llm } : {}),
  };
  return { app: await buildApp(deps), events };
}

function txnEvent(txnId: string, amountMinor: number, postedDate: string, category: string): UnsequencedEvent {
  return {
    eventId: txnId,
    type: "TransactionPosted",
    schemaVersion: 1,
    occurredAt: "2026-07-12T10:00:00.000Z",
    source: "user",
    idempotencyKey: txnId,
    payload: {
      txnId,
      accountId: "acc-1",
      amountMinor,
      currency: "USD",
      status: "posted",
      postedDate,
      merchantRaw: `SECRET-MERCHANT-${txnId}`,
      category,
      categorySource: "user",
    },
  };
}

async function seed(events: InMemoryEventStore, userId: string) {
  await events.appendBatch(
    userId,
    [
      txnEvent("t-groceries", -6_842, "2026-06-10", "Groceries"),
      txnEvent("t-dining", -3_000, "2026-06-15", "Dining"),
    ],
    "seed",
  );
}

const JUNE = { fromDate: "2026-06-01", toDate: "2026-06-30" };

describe("POST /chat", () => {
  it("routes a spending question, executes deterministically, returns a faithful answer", async () => {
    const gw = scriptedGateway(
      { tool: "spend_total", args: JUNE },
      "You spent $98.42 across June.",
    );
    const { app, events } = await appWith(gw);
    const auth = await registerHeaders(app);
    await seed(events, auth.userId);

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: auth.headers,
      payload: { question: "how much did I spend in June?", todayLocal: "2026-07-12" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("llm");
    expect(body.tool).toBe("spend_total");
    expect(body.answer).toContain("$98.42"); // 6842 + 3000 = 9842 minor
    expect(body.data.total).toBe("$98.42");
  });

  it("ALLOWLIST: raw transactions never appear in any prompt the model sees", async () => {
    const gw = scriptedGateway({ tool: "spend_by_category", args: JUNE }, "Groceries $68.42, Dining $30.00.");
    const { app, events } = await appWith(gw);
    const auth = await registerHeaders(app);
    await seed(events, auth.userId);

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: auth.headers,
      payload: { question: "what did I spend on?", todayLocal: "2026-07-12" },
    });
    // Neither the routing prompt nor the phrasing prompt carries merchant names
    // or transaction ids — only the question and computed category aggregates.
    for (const prompt of gw.prompts) {
      expect(prompt).not.toContain("SECRET-MERCHANT");
      expect(prompt).not.toContain("t-groceries");
    }
  });

  it("unfaithful phrasing (invented number) → deterministic template answer", async () => {
    const gw = scriptedGateway(
      { tool: "spend_total", args: JUNE },
      "You spent $98.42 — about $500.00 more than average.", // $500 invented
    );
    const { app, events } = await appWith(gw);
    const auth = await registerHeaders(app);
    await seed(events, auth.userId);

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: auth.headers,
      payload: { question: "june spend?", todayLocal: "2026-07-12" },
    });
    const body = res.json();
    expect(body.source).toBe("template");
    expect(body.answer).toContain("$98.42");
    expect(body.answer).not.toContain("$500.00"); // the invented figure never ships
  });

  it("out-of-scope question (router picks null) → helpful boundary message", async () => {
    const gw = scriptedGateway({ tool: null }, "irrelevant");
    const { app, events } = await appWith(gw);
    const auth = await registerHeaders(app);
    await seed(events, auth.userId);

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: auth.headers,
      payload: { question: "what's the weather?", todayLocal: "2026-07-12" },
    });
    expect(res.json().source).toBe("out_of_scope");
    expect(res.json().tool).toBeNull();
  });

  it("no provider → 503; unauthenticated → 401; bad input → 400", async () => {
    const noLlm = await appWith();
    const authed = await registerHeaders(noLlm.app);
    expect(
      (await noLlm.app.inject({
        method: "POST",
        url: "/chat",
        headers: authed.headers,
        payload: { question: "hi", todayLocal: "2026-07-12" },
      })).statusCode,
    ).toBe(503);

    const { app } = await appWith(scriptedGateway({ tool: null }, "x"));
    expect(
      (await app.inject({ method: "POST", url: "/chat", payload: { question: "hi", todayLocal: "2026-07-12" } }))
        .statusCode,
    ).toBe(401);

    const auth = await registerHeaders(app);
    expect(
      (await app.inject({ method: "POST", url: "/chat", headers: auth.headers, payload: { question: "" } }))
        .statusCode,
    ).toBe(400);
  });
});
