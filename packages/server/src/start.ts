/**
 * Dev server: real app, in-memory stores, no Plaid credentials yet.
 * `npm run dev -w @xerebro/server`, then point the Expo app at it.
 * NOT for deployment: in-memory log, trust-all webhook verifier.
 */
import { randomUUID } from "node:crypto";
import { buildApp, DEV_TRUST_ALL_VERIFIER } from "./app";
import { InMemoryEventStore } from "./eventStore";
import { InMemoryItemStore, InMemoryTxnRegistry } from "./plaid/stores";

const app = buildApp({
  plaid: {
    async transactionsSync() {
      throw new Error("Plaid not configured yet — dev server serves /events only");
    },
  },
  events: new InMemoryEventStore(),
  items: new InMemoryItemStore(),
  registry: new InMemoryTxnRegistry(),
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
  webhookVerifier: DEV_TRUST_ALL_VERIFIER,
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => console.log(`xerebro dev server on :${port} (in-memory, dev only)`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
