/**
 * The proxy's three promises, each proven: allowlist by construction (extra
 * fields never reach the prompt), faithfulness enforcement (invented numbers
 * and verdict contradictions are discarded), graceful absence (no provider →
 * 503, clients keep templates).
 */
import { describe, expect, it } from "vitest";
import { decidePurchase, type VerificationResult } from "@xerebro/engines";
import { buildApp, DEV_TRUST_ALL_VERIFIER, type AppDeps } from "../src/app";
import { InMemoryAuthStore } from "../src/auth/store";
import { registerHeaders } from "./helpers";
import { buildPromptPayload, explainDecision } from "../src/llm/explain";
import type { LlmGateway } from "../src/llm/gateway";
import { InMemoryEventStore } from "../src/eventStore";
import { InMemoryItemStore, InMemoryTxnRegistry } from "../src/plaid/stores";

const decision = decidePurchase(
  { availableCashMinor: 520_000, upcomingObligationsMinor: 7_430 },
  { amountMinor: 60_000, description: "espresso machine" },
);
const verification: VerificationResult = {
  status: "VERIFIED",
  confidence: 1,
  boundedBy: "freshness",
  dataAgeSeconds: 3600,
  missingInputs: [],
};

function scriptedGateway(text: string): LlmGateway & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async complete({ user }) {
      prompts.push(user);
      return { text, model: "test-model" };
    },
  };
}

function appWith(llm?: LlmGateway) {
  let authN = 0;
  const deps: AppDeps = {
    plaid: { transactionsSync: async () => { throw new Error("unused"); } },
    events: new InMemoryEventStore(),
    items: new InMemoryItemStore(),
    registry: new InMemoryTxnRegistry(),
    now: () => "2026-07-08T10:00:00.000Z",
    newEventId: () => "e",
    webhookVerifier: DEV_TRUST_ALL_VERIFIER,
    auth: new InMemoryAuthStore({
      now: () => "2026-07-08T10:00:00.000Z",
      newId: () => `auth-id-${++authN}`,
    }),
    ...(llm ? { llm } : {}),
  };
  return buildApp(deps);
}

async function injectExplain(app: ReturnType<typeof buildApp>, payload: unknown) {
  const { headers } = await registerHeaders(app);
  return app.inject({ method: "POST", url: "/explanations", payload: payload as object, headers });
}

describe("explanation proxy", () => {
  it("faithful output passes through with provider metadata", async () => {
    const gateway = scriptedGateway(
      "Yes — the espresso machine at $600.00 fits comfortably: $4,525.70 remains after your $74.30 of bills.",
    );
    const res = await explainDecision(gateway, { decision, verification });
    expect(res.text).toContain("espresso machine");
    expect(res).toMatchObject({ provider: "openai", model: "test-model", promptTemplateVersion: "tmpl-v1" });
  });

  it("ALLOWLIST: extra fields in the request never reach the prompt", async () => {
    const gateway = scriptedGateway("Yes — $600.00 fits; $4,525.70 remains.");
    const smuggled = {
      decision: {
        ...decision,
        merchantHistory: ["Blue Bottle", "acct-4421-9987"], // not allowlisted
        inputsSnapshot: { ...decision.inputsSnapshot, accountNumber: "4421-9987" },
      },
      verification,
    };
    await explainDecision(gateway, smuggled as never);
    expect(gateway.prompts[0]).not.toContain("4421");
    expect(gateway.prompts[0]).not.toContain("Blue Bottle");
    expect(gateway.prompts[0]).not.toContain("merchantHistory");
  });

  it("prompt contains only pre-formatted money strings (model never does math)", () => {
    const payload = buildPromptPayload({ decision, verification });
    expect(payload.amounts).toEqual({
      purchase: "$600.00",
      availableCash: "$5,200.00",
      upcomingBills30d: "$74.30",
      bufferFloor: "$500.00",
      remainingAfterPurchase: "$4,525.70",
    });
    expect(payload.product).toBe("espresso machine");
  });

  it("HTTP: invented figures → 422 with violations; client keeps its template", async () => {
    const app = appWith(scriptedGateway("Yes — $600.00 is fine; similar machines cost $349.99."));
    const res = await injectExplain(app, { decision, verification });
    expect(res.statusCode).toBe(422);
    expect(res.json().violations[0]).toContain("$349.99");
  });

  it("HTTP: verdict contradiction → 422", async () => {
    const decline = decidePurchase(
      { availableCashMinor: 50_000, upcomingObligationsMinor: 30_000 },
      { amountMinor: 60_000 },
    );
    const app = appWith(scriptedGateway("Yes — you can afford this, go for it!"));
    const res = await injectExplain(app, { decision: decline, verification });
    expect(res.statusCode).toBe(422);
  });

  it("HTTP: no provider configured → 503; provider error → 502", async () => {
    const no = await injectExplain(appWith(), { decision, verification });
    expect(no.statusCode).toBe(503);

    const failing: LlmGateway = { complete: async () => { throw new Error("boom"); } };
    const bad = await injectExplain(appWith(failing), { decision, verification });
    expect(bad.statusCode).toBe(502);
  });
});
