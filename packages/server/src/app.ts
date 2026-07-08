/**
 * Thin backend HTTP surface (docs/adr/ADR-001-topology.md): webhook ingestion
 * and the sync spine. Everything is dependency-injected so tests run the real
 * app with fakes at the seams.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { EventStore, UnsequencedEvent } from "./eventStore";
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
  /** Absent = no provider configured; /explanations returns 503 and clients
   * keep their template explanations (docs/AIArchitecture.md fallback). */
  llm?: LlmGateway;
}

interface PlaidWebhookBody {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
}

interface UserEventsBody {
  userId?: string;
  events?: UnsequencedEvent[];
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

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

  /** Device delta sync (ADR-001: down — events by server sequence). */
  app.get<{ Querystring: { userId?: string; since?: string; limit?: string } }>(
    "/events",
    async (request, reply) => {
      const { userId, since = "0", limit = "500" } = request.query;
      if (!userId) return reply.code(400).send({ error: "userId required" });
      const events = await deps.events.eventsSince(
        userId,
        Number.parseInt(since, 10) || 0,
        Math.min(Number.parseInt(limit, 10) || 500, 500),
      );
      return reply.send({ events, lastSequence: await deps.events.lastSequence(userId) });
    },
  );

  /** Device events up (ADR-001: user actions/annotations; producer idempotency keys). */
  app.post<{ Body: UserEventsBody }>("/events", async (request, reply) => {
    const { userId, events } = request.body ?? {};
    if (!userId || !Array.isArray(events) || events.length === 0) {
      return reply.code(400).send({ error: "userId and non-empty events[] required" });
    }
    for (const e of events) {
      if (e.source !== "user" || !e.idempotencyKey || !e.eventId || !e.type) {
        return reply
          .code(400)
          .send({ error: "device events must have source 'user', eventId, type, idempotencyKey" });
      }
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
