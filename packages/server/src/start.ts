/**
 * Dev server: real app, no Plaid credentials yet.
 * `npm run dev -w @xerebro/server`, then point the Expo app at it.
 * Storage: Postgres when DATABASE_URL is set (npm run db:up), else in-memory.
 * NOT for deployment: trust-all webhook verifier, dev .env loader.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp, DEV_TRUST_ALL_VERIFIER } from "./app";
import { InMemoryAuthStore } from "./auth/store";
import { InMemoryEventStore } from "./eventStore";
import { openAiGateway } from "./llm/gateway";
import {
  createPool,
  ensureSchema,
  PostgresAuthStore,
  PostgresEventStore,
  PostgresItemStore,
  PostgresTxnRegistry,
} from "./persistence/postgres";
import { InMemoryItemStore, InMemoryTxnRegistry } from "./plaid/stores";

/**
 * Dev-only .env loader (packages/server/.env, gitignored — see .env.example).
 * Real env vars win over the file. Deployed environments won't use this:
 * secrets there come from a managed store (docs/SecurityPrivacy.md).
 */
function loadDotEnv(): void {
  const path = join(import.meta.dirname, "..", ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
    }
  }
}
loadDotEnv();

// Set OPENAI_API_KEY and OPENAI_MODEL (env or packages/server/.env) to enable
// AI explanations; without them the app keeps its template explanations.
const llm =
  process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL
    ? openAiGateway({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL })
    : undefined;

// Set DATABASE_URL (env or .env) for durable Postgres storage — see
// compose.yaml + README. Without it: in-memory, wiped on restart.
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? createPool(databaseUrl) : undefined;
if (pool) await ensureSchema(pool);

const app = buildApp({
  ...(llm ? { llm } : {}),
  plaid: {
    async transactionsSync() {
      throw new Error("Plaid not configured yet — dev server serves /events only");
    },
  },
  events: pool ? new PostgresEventStore(pool) : new InMemoryEventStore(),
  items: pool ? new PostgresItemStore(pool) : new InMemoryItemStore(),
  registry: pool ? new PostgresTxnRegistry(pool) : new InMemoryTxnRegistry(),
  auth: pool
    ? new PostgresAuthStore(pool, { now: () => new Date().toISOString(), newId: () => randomUUID() })
    : new InMemoryAuthStore({ now: () => new Date().toISOString(), newId: () => randomUUID() }),
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
  webhookVerifier: DEV_TRUST_ALL_VERIFIER,
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() =>
    console.log(
      `xerebro dev server on :${port} (storage: ${pool ? "postgres (durable)" : "in-memory - wiped on restart; set DATABASE_URL"}; AI explanations ${llm ? "ON" : "OFF - set OPENAI_API_KEY + OPENAI_MODEL"})`,
    ),
  )
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
