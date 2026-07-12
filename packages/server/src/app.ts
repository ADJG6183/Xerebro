/**
 * Thin backend HTTP surface (docs/adr/ADR-001-topology.md): webhook ingestion
 * and the sync spine. Everything is dependency-injected so tests run the real
 * app with fakes at the seams.
 */
import { validateEventPayload } from "@xerebro/engines";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AuthSession, AuthStore } from "./auth/store";
import { answerQuestion } from "./copilot/chat";
import type { UnsequencedEvent } from "./eventStore";
import {
  explainDecision,
  UnfaithfulExplanationError,
  type ExplainRequest,
} from "./llm/explain";
import type { LlmGateway } from "./llm/gateway";
import { syncPlaidItem, type AclDeps } from "./plaid/acl";

/**
 * Plaid webhook authenticity check. MUST be replaced with Plaid's JWT
 * verification before this port is ever internet-reachable
 * (docs/SecurityPrivacy.md) — the dev implementation trusts everything.
 */
export interface WebhookVerifier {
  verify(headers: Record<string, unknown>, rawBody: string): Promise<boolean>;
}

export const DEV_TRUST_ALL_VERIFIER: WebhookVerifier = {
  async verify() {
    return true;
  },
};

export interface AppDeps extends AclDeps {
  webhookVerifier: WebhookVerifier;
  auth: AuthStore;
  /** Absent = no provider configured; /explanations returns 503 and clients
   * keep their template explanations (docs/AIArchitecture.md fallback). */
  llm?: LlmGateway;
}

/** Paths that authenticate themselves differently (or not yet). */
const UNAUTHENTICATED_PREFIXES = ["/auth/", "/webhooks/"];

function sessionOf(request: FastifyRequest): AuthSession {
  // Set by the onRequest hook; routes behind it can rely on its presence.
  return (request as FastifyRequest & { session: AuthSession }).session;
}

interface PlaidWebhookBody {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
}

interface UserEventsBody {
  events?: UnsequencedEvent[];
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  /**
   * The trust boundary (SecurityPrivacy.md): identity comes from a verified
   * bearer token, NEVER from the request. Every route except /auth/* and
   * /webhooks/* (which verifies itself Plaid's way) requires one.
   */
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (UNAUTHENTICATED_PREFIXES.some((p) => path.startsWith(p))) return;
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const session = token ? await deps.auth.verifyAccess(token) : null;
    if (!session) return reply.code(401).send({ error: "authentication required" });
    (request as FastifyRequest & { session: AuthSession }).session = session;
  });

  /** Anonymous device registration (staged auth — identity linking later). */
  app.post<{ Body: { deviceName?: string } }>("/auth/register", async (request, reply) => {
    const result = await deps.auth.registerDevice(request.body?.deviceName ?? "unnamed device");
    return reply.code(201).send(result);
  });

  /** Rotate the token pair. 401 = invalid/expired/stolen → client re-registers. */
  app.post<{ Body: { refreshToken?: string } }>("/auth/refresh", async (request, reply) => {
    const { refreshToken } = request.body ?? {};
    if (!refreshToken) return reply.code(400).send({ error: "refreshToken required" });
    const result = await deps.auth.refresh(refreshToken);
    if (!result) return reply.code(401).send({ error: "invalid refresh token" });
    return reply.send(result);
  });

  /**
   * Plaid webhooks are notifications-to-fetch: the body says "item X has
   * updates", never the data itself. We ack fast and drain transactions/sync.
   */
  app.post<{ Body: PlaidWebhookBody }>("/webhooks/plaid", async (request, reply) => {
    const ok = await deps.webhookVerifier.verify(
      request.headers as Record<string, unknown>,
      JSON.stringify(request.body),
    );
    if (!ok) return reply.code(401).send({ error: "webhook verification failed" });

    const { webhook_type, webhook_code, item_id } = request.body ?? {};
    if (webhook_type !== "TRANSACTIONS" || !item_id) {
      return reply.code(202).send({ handled: false }); // unknown kinds are acked, not errors
    }
    if (webhook_code === "SYNC_UPDATES_AVAILABLE") {
      const outcome = await syncPlaidItem(deps, item_id);
      return reply.code(200).send({ handled: true, ...outcome });
    }
    return reply.code(202).send({ handled: false });
  });

  /**
   * On-demand refresh — the server half of verification's refresh-race
   * (docs/verificationEngine.md): the device calls this when its data is
   * outside the freshness window, with its own 3s timeout. Draining
   * transactions/sync is idempotent, so a webhook landing at the same
   * moment cannot double-ingest.
   */
  app.post<{ Params: { itemId: string } }>("/items/:itemId/refresh", async (request, reply) => {
    // Ownership check: you can only refresh YOUR bank connections.
    const item = await deps.items.get(request.params.itemId);
    if (!item || item.userId !== sessionOf(request).userId) {
      return reply.code(404).send({ error: "unknown item" });
    }
    try {
      const outcome = await syncPlaidItem(deps, request.params.itemId);
      return reply.send(outcome);
    } catch {
      return reply.code(502).send({ error: "aggregator refresh failed" });
    }
  });

  /**
   * LLM explanation proxy — the ONLY path to a model provider
   * (docs/SecurityPrivacy.md). The prompt is built exclusively from fields
   * PICKED inside explainDecision; anything extra in the body never reaches
   * the model. Unfaithful output is discarded (422) — clients keep the
   * template.
   */
  app.post<{ Body: ExplainRequest }>("/explanations", async (request, reply) => {
    if (!deps.llm) return reply.code(503).send({ error: "no LLM provider configured" });
    const { decision, verification } = request.body ?? {};
    if (!decision?.inputsSnapshot || !decision.decision || !verification?.status) {
      return reply.code(400).send({ error: "decision and verification required" });
    }
    try {
      return reply.send(await explainDecision(deps.llm, { decision, verification }));
    } catch (err) {
      if (err instanceof UnfaithfulExplanationError) {
        return reply.code(422).send({ error: "unfaithful explanation discarded", violations: err.violations });
      }
      return reply.code(502).send({ error: "explanation provider failed" });
    }
  });

  /**
   * Copilot chat (docs/copilotArchitecture.md). Tool execution runs here over
   * the user's own event log; only the question and computed aggregates reach
   * the provider. Needs the LLM proxy — without it, 503 and the client shows
   * a "chat unavailable" state (never a broken screen).
   */
  app.post<{ Body: { question?: string; todayLocal?: string } }>("/chat", async (request, reply) => {
    if (!deps.llm) return reply.code(503).send({ error: "no LLM provider configured" });
    const { userId } = sessionOf(request);
    const { question, todayLocal } = request.body ?? {};
    if (!question?.trim() || !todayLocal || !/^\d{4}-\d{2}-\d{2}$/.test(todayLocal)) {
      return reply.code(400).send({ error: "question and todayLocal (YYYY-MM-DD) required" });
    }
    const events = await deps.events.eventsSince(userId, 0, 100_000);
    try {
      return reply.send(await answerQuestion(deps.llm, { question: question.trim(), events, todayLocal }));
    } catch {
      return reply.code(502).send({ error: "chat provider failed" });
    }
  });

  /** Device delta sync (ADR-001: down — events by server sequence).
   * The userId is the TOKEN's, not the caller's claim. */
  app.get<{ Querystring: { since?: string; limit?: string } }>(
    "/events",
    async (request, reply) => {
      const { userId } = sessionOf(request);
      const { since = "0", limit = "500" } = request.query;
      const events = await deps.events.eventsSince(
        userId,
        Math.max(0, Number.parseInt(since, 10) || 0),
        Math.min(Math.max(1, Number.parseInt(limit, 10) || 500), 500),
      );
      return reply.send({ events, lastSequence: await deps.events.lastSequence(userId) });
    },
  );

  /** Device events up (ADR-001: user actions/annotations; producer idempotency keys). */
  app.post<{ Body: UserEventsBody }>("/events", async (request, reply) => {
    const { userId } = sessionOf(request);
    const { events } = request.body ?? {};
    if (!Array.isArray(events) || events.length === 0) {
      return reply.code(400).send({ error: "non-empty events[] required" });
    }
    for (const e of events) {
      if (e.source !== "user" || !e.idempotencyKey || !e.eventId || !e.type) {
        return reply
          .code(400)
          .send({ error: "device events must have source 'user', eventId, type, idempotencyKey" });
      }
    }
    // Poison-pill defense (engines/validation.ts): the log is append-only,
    // so malformed payloads are rejected AT THE DOOR — whole batch, atomically
    // (a producer's batch is one intent; half-applying it corrupts the story).
    const violations = events.flatMap((e) =>
      validateEventPayload(e.type, e.payload).map((v) => `${e.eventId}: ${v}`),
    );
    if (violations.length > 0) {
      return reply.code(400).send({ error: "invalid event payloads", violations });
    }
    const batchKey = `device:${userId}:${events.map((e) => e.idempotencyKey).join(",")}`;
    const result = await deps.events.appendBatch(userId, events, batchKey);
    return reply.send({
      appended: result.appended.map((e) => e.sequence),
      lastSequence: await deps.events.lastSequence(userId),
    });
  });

  return app;
}
