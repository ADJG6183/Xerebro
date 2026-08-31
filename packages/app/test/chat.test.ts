/**
 * The client → server chat contract, end to end through the real server with
 * a scripted gateway. Proves the transport's chat() returns a CopilotAnswer
 * the ChatScreen can render, and that the deterministic figures survive the
 * round trip.
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
import type { LlmGateway } from "@xerebro/server";
import type { CopilotAnswer } from "../src/data/chat";

function scriptedGateway(route: object, phrase: string): LlmGateway {
  return {
    async complete({ user }) {
      return { text: user.includes('"tools"') ? JSON.stringify(route) : phrase, model: "test-model" };
    },
  };
}

async function makeServer(llm: LlmGateway) {
  let a = 0;
  const events = new InMemoryEventStore();
  const deps: AppDeps = {
    plaid: { transactionsSync: async () => { throw new Error("unused"); } },
    events,
    items: new InMemoryItemStore(),
    registry: new InMemoryTxnRegistry(),
    now: () => "2026-07-12T10:00:00.000Z",
    newEventId: () => "e",
    webhookVerifier: DEV_TRUST_ALL_VERIFIER,
    auth: new InMemoryAuthStore({ now: () => "2026-07-12T10:00:00.000Z", newId: () => `id-${++a}` }),
    llm,
  };
  return { app: await buildApp(deps), events };
}

/** A transport.chat() implemented over the real server via inject. */
function chatVia(app: Awaited<ReturnType<typeof buildApp>>, token: string) {
  return async (question: string, todayLocal: string): Promise<CopilotAnswer> => {
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { question, todayLocal },
    });
    if (res.statusCode !== 200) throw new Error(`chat ${res.statusCode}`);
    return res.json() as CopilotAnswer;
  };
}

describe("copilot transport contract", () => {
  it("returns a faithful CopilotAnswer with its computed trace", async () => {
    const gw = scriptedGateway(
      { tool: "financial_summary", args: {} },
      "You have $5,000.00 available and a net worth of $5,000.00.",
    );
    const { app, events } = await makeServer(gw);
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: {} });
    const { accessToken, userId } = reg.json() as { accessToken: string; userId: string };

    await events.appendBatch(
      userId,
      [
        {
          eventId: "acc",
          type: "AccountUpserted",
          schemaVersion: 1,
          occurredAt: "2026-07-12T10:00:00.000Z",
          source: "user",
          idempotencyKey: "acc",
          payload: {
            accountId: "a1",
            type: "checking",
            source: "manual",
            name: "Checking",
            currency: "USD",
            balanceCurrentMinor: 0,
            balanceAsOf: "2026-07-12T10:00:00.000Z",
            status: "active",
            openingBalanceMinor: 500_000,
          },
        },
      ],
      "seed",
    );

    const chat = chatVia(app, accessToken);
    const answer = await chat("what's my available cash?", "2026-07-12");

    expect(answer.source).toBe("llm");
    expect(answer.tool).toBe("financial_summary");
    expect(answer.answer).toContain("$5,000.00");
    expect(answer.data?.availableCash).toBe("$5,000.00");
  });
});
