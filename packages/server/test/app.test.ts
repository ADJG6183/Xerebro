import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { makeDeps, page, plaidTxn, registerHeaders } from "./helpers";

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

    const auth = await registerHeaders(app);
    const sync = await app.inject({ method: "GET", url: "/events?since=0", headers: auth.headers });
    expect(sync.statusCode).toBe(200);
    const body = sync.json();
    expect(body.lastSequence).toBe(1);
    expect(body.events[0]).toMatchObject({ type: "TransactionPosted", sequence: 1 });

    // Delta semantics: already-synced devices get nothing new.
    const delta = await app.inject({ method: "GET", url: "/events?since=1", headers: auth.headers });
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
    const owner = await registerHeaders(app); // user-1 owns item-1
    const ok = await app.inject({ method: "POST", url: "/items/item-1/refresh", headers: owner.headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ appended: 1 });

    const failing = buildApp(await makeDeps({})); // fake gateway has no page scripted → throws
    const failOwner = await registerHeaders(failing);
    const bad = await failing.inject({ method: "POST", url: "/items/item-1/refresh", headers: failOwner.headers });
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
    const auth = await registerHeaders(app);
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
      headers: auth.headers, payload: { events: [annotation] },
    });
    expect(first.json()).toMatchObject({ appended: [1], lastSequence: 1 });

    const resend = await app.inject({
      method: "POST",
      url: "/events",
      headers: auth.headers, payload: { events: [annotation] },
    });
    expect(resend.json()).toMatchObject({ appended: [], lastSequence: 1 });
  });

  it("rejects poison payloads at the door: float money → 400, nothing appended", async () => {
    const deps = await makeDeps({});
    const app = buildApp(deps);
    const auth = await registerHeaders(app);
    const res = await app.inject({
      method: "POST",
      url: "/events",
      headers: auth.headers,
      payload: {
        events: [
          {
            eventId: "ok-1", type: "TransactionAnnotated", schemaVersion: 1,
            occurredAt: "2026-07-10T10:00:00.000Z", source: "user", idempotencyKey: "k-ok",
            payload: { txnId: "t1", categoryOverride: "Coffee" },
          },
          {
            eventId: "bad-1", type: "TransactionPosted", schemaVersion: 1,
            occurredAt: "2026-07-10T10:00:00.000Z", source: "user", idempotencyKey: "k-bad",
            payload: { txnId: "t2", accountId: "a", amountMinor: 10.5, status: "posted", merchantRaw: "m", currency: "USD", categorySource: "user" },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().violations.join(" ")).toContain("bad-1");
    // Atomic: the valid event in the same batch was NOT half-applied.
    expect(await deps.events.lastSequence("user-1")).toBe(0);
  });

  it("rejects nested float money hidden inside an audit-record payload", async () => {
    const app = buildApp(await makeDeps({}));
    const auth = await registerHeaders(app);
    const res = await app.inject({
      method: "POST",
      url: "/events",
      headers: auth.headers,
      payload: {
        events: [
          {
            eventId: "rec-1", type: "RecommendationRecorded", schemaVersion: 1,
            occurredAt: "2026-07-10T10:00:00.000Z", source: "user", idempotencyKey: "k-rec",
            payload: { recommendationId: "r1", decision: { tradeoffs: [{ code: "x", amountMinor: 0.30000000000000004 }] } },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().violations.join(" ")).toContain("amountMinor");
  });

  it("rejects device events that claim a non-user source (spoofed provenance)", async () => {
    const app = buildApp(await makeDeps({}));
    const auth = await registerHeaders(app);
    const res = await app.inject({
      method: "POST",
      url: "/events",
      headers: auth.headers,
      payload: {
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
