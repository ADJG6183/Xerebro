import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { makeDeps, page, plaidTxn } from "./helpers";

describe("HTTP surface (real app, fake seams)", () => {
  it("webhook → drain → events available on the device sync endpoint", async () => {
    const deps = await makeDeps({
      "": page({ added: [plaidTxn({ transaction_id: "t-1" })] }, "c1"),
    });
    const app = buildApp(deps);

    const webhook = await app.inject({
      method: "POST",
      url: "/webhooks/plaid",
      payload: {
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: "item-1",
      },
    });
    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toMatchObject({ handled: true, appended: 1 });

    const sync = await app.inject({ method: "GET", url: "/events?userId=user-1&since=0" });
    expect(sync.statusCode).toBe(200);
    const body = sync.json();
    expect(body.lastSequence).toBe(1);
    expect(body.events[0]).toMatchObject({ type: "TransactionPosted", sequence: 1 });

    // Delta semantics: already-synced devices get nothing new.
    const delta = await app.inject({ method: "GET", url: "/events?userId=user-1&since=1" });
    expect(delta.json().events).toHaveLength(0);
  });

  it("unknown webhook kinds are acked (202), never errors — aggregators retry on 5xx", async () => {
    const app = buildApp(await makeDeps({}));
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/plaid",
      payload: { webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-1" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ handled: false });
  });

  it("POST /items/:id/refresh drains sync on demand; aggregator failure maps to 502", async () => {
    const app = buildApp(
      await makeDeps({ "": page({ added: [plaidTxn({ transaction_id: "t-r" })] }, "c1") }),
    );
    const ok = await app.inject({ method: "POST", url: "/items/item-1/refresh" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ appended: 1 });

    const failing = buildApp(await makeDeps({})); // fake gateway has no page scripted → throws
    const bad = await failing.inject({ method: "POST", url: "/items/item-1/refresh" });
    expect(bad.statusCode).toBe(502);
    expect(bad.json()).toEqual({ error: "aggregator refresh failed" });
  });

  it("rejects unverified webhooks with 401", async () => {
    const deps = await makeDeps({});
    deps.webhookVerifier = { verify: async () => false };
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/plaid",
      payload: { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("device events up: appends with producer idempotency, resend is a no-op", async () => {
    const app = buildApp(await makeDeps({}));
    const annotation = {
      eventId: "dev-evt-1",
      type: "TransactionAnnotated",
      schemaVersion: 1,
      occurredAt: "2026-07-07T13:00:00.000Z",
      source: "user",
      idempotencyKey: "device-a:annotate:txn-1:1",
      payload: { txnId: "txn-1", categoryOverride: "Coffee" },
    };

    const first = await app.inject({
      method: "POST",
      url: "/events",
      payload: { userId: "user-1", events: [annotation] },
    });
    expect(first.json()).toMatchObject({ appended: [1], lastSequence: 1 });

    const resend = await app.inject({
      method: "POST",
      url: "/events",
      payload: { userId: "user-1", events: [annotation] },
    });
    expect(resend.json()).toMatchObject({ appended: [], lastSequence: 1 });
  });

  it("rejects device events that claim a non-user source (spoofed provenance)", async () => {
    const app = buildApp(await makeDeps({}));
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: {
        userId: "user-1",
        events: [
          {
            eventId: "dev-evt-2",
            type: "TransactionPosted",
            schemaVersion: 1,
            occurredAt: "2026-07-07T13:00:00.000Z",
            source: "plaid", // a device may never impersonate the aggregator
            idempotencyKey: "k",
            payload: {},
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
