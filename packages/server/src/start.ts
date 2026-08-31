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
import { plaidHttpGateway, plaidHttpLinkGateway } from "./plaid/httpGateway";
import { plaidKeyFetcher, plaidWebhookVerifier } from "./plaid/webhookVerifier";
import { createTokenVault, PLAINTEXT_DEV_VAULT } from "./plaid/tokenVault";
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

// Bank linking: set PLAID_CLIENT_ID + PLAID_SECRET (+ PLAID_ENV, default
// sandbox) to enable. Without them the app stays manual-only and /plaid/*
// answers 503 — the same graceful-absence pattern as the LLM.
const plaidConfig =
  process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET
    ? {
        clientId: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        env: (process.env.PLAID_ENV === "production" ? "production" : "sandbox") as
          | "sandbox"
          | "production",
        ...(process.env.PLAID_WEBHOOK_URL ? { webhookUrl: process.env.PLAID_WEBHOOK_URL } : {}),
        // Hosted Link returns here when the user finishes. Must be an https
        // URL registered in the Plaid dashboard; without it Plaid shows its
        // own "you're done" screen and the app picks changes up on refresh.
        ...(process.env.PLAID_LINK_COMPLETION_URL
          ? { linkCompletionUrl: process.env.PLAID_LINK_COMPLETION_URL }
          : {}),
      }
    : undefined;

// Access tokens are sealed at rest when a key is configured
// (openssl rand -base64 32). The dev fallback is named to be unmistakable.
const tokens = process.env.PLAID_TOKEN_KEY
  ? createTokenVault(process.env.PLAID_TOKEN_KEY)
  : PLAINTEXT_DEV_VAULT;

const app = await buildApp({
  ...(llm ? { llm } : {}),
  plaid: plaidConfig
    ? plaidHttpGateway(plaidConfig)
    : {
        async transactionsSync() {
          throw new Error("Plaid not configured — set PLAID_CLIENT_ID and PLAID_SECRET");
        },
      },
  ...(plaidConfig ? { plaidLink: plaidHttpLinkGateway(plaidConfig) } : {}),
  tokens,
  events: pool ? new PostgresEventStore(pool) : new InMemoryEventStore(),
  items: pool ? new PostgresItemStore(pool) : new InMemoryItemStore(),
  registry: pool ? new PostgresTxnRegistry(pool) : new InMemoryTxnRegistry(),
  auth: pool
    ? new PostgresAuthStore(pool, { now: () => new Date().toISOString(), newId: () => randomUUID() })
    : new InMemoryAuthStore({ now: () => new Date().toISOString(), newId: () => randomUUID() }),
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
  // Real ES256 verification whenever Plaid is configured; the trust-all
  // stub only survives in fully-local manual mode (SecurityPrivacy.md).
  webhookVerifier: plaidConfig
    ? plaidWebhookVerifier(plaidKeyFetcher(plaidConfig))
    : DEV_TRUST_ALL_VERIFIER,
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() =>
    console.log(
      `xerebro dev server on :${port} (storage: ${pool ? "postgres (durable)" : "in-memory - wiped on restart; set DATABASE_URL"}; AI explanations ${llm ? "ON" : "OFF - set OPENAI_API_KEY + OPENAI_MODEL"}; bank linking ${plaidConfig ? `ON (${plaidConfig.env})` : "OFF - set PLAID_CLIENT_ID + PLAID_SECRET"})`,
    ),
  )
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
