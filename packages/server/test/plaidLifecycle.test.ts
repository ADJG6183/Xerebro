import { foldAccounts } from "@xerebro/engines";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { PlaidApiError } from "../src/plaid/httpGateway";
import { processNextPlaidJob } from "../src/plaid/lifecycle";
import { makeDeps, page, registerHeaders } from "./helpers";

async function seedConnectedAccount(deps: Awaited<ReturnType<typeof makeDeps>>) {
  await deps.events.appendBatch(
    "user-1",
    [
      {
        eventId: "account-event",
        type: "AccountUpserted",
        schemaVersion: 1,
        occurredAt: deps.now(),
        source: "plaid",
        idempotencyKey: "account-seed",
        payload: {
          accountId: "account-1",
          type: "checking",
          source: "plaid",
          name: "Checking",
          currency: "USD",
          balanceCurrentMinor: 10_000,
          balanceAvailableMinor: 9_000,
          balanceAsOf: deps.now(),
          status: "active",
          plaidItemId: "item-1",
          reconciliationStatus: "unknown",
        },
      },
      {
        eventId: "txn-event",
        type: "TransactionPosted",
        schemaVersion: 1,
        occurredAt: deps.now(),
        source: "plaid",
        idempotencyKey: "txn-seed",
        payload: {
          txnId: "txn-1",
          accountId: "account-1",
          amountMinor: -500,
          currency: "USD",
          status: "posted",
          postedDate: "2026-07-07",
          merchantRaw: "Coffee",
          categorySource: "plaid",
        },
      },
    ],
    "lifecycle-seed",
  );
}

describe("durable Plaid lifecycle", () => {
  it("disconnects access and spendable balance but retains imported history", async () => {
    const deps = await makeDeps({});
    await seedConnectedAccount(deps);
    const removed: string[] = [];
    deps.plaid.itemRemove = async (token) => {
      removed.push(token);
    };
    const app = await buildApp(deps);
    const owner = await registerHeaders(app);

    const result = await app.inject({
      method: "POST",
      url: "/items/item-1/disconnect",
      headers: owner.headers,
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ status: "disconnected" });
    expect(removed).toEqual(["tok-ref"]);
    expect(await deps.items.get("item-1")).toMatchObject({
      status: "disconnected",
      accessTokenRef: "",
    });
    const listed = await app.inject({ method: "GET", url: "/items", headers: owner.headers });
    expect(listed.json()).toEqual({ items: [{ itemId: "item-1", status: "disconnected" }] });
    expect(listed.body).not.toContain("tok-ref");
    const events = await deps.events.eventsSince("user-1", 0, 100);
    expect(foldAccounts(events)[0]?.status).toBe("disconnected");
    expect(
      events.some(
        (event) =>
          event.type === "TransactionPosted" &&
          (event.payload as { txnId?: string }).txnId === "txn-1",
      ),
    ).toBe(true);
  });

  it("keeps a failed removal durable and safely retries it", async () => {
    const deps = await makeDeps({});
    await seedConnectedAccount(deps);
    deps.plaid.itemRemove = async () => {
      throw new PlaidApiError("down", 500, "INTERNAL_SERVER_ERROR");
    };
    const app = await buildApp(deps);
    const owner = await registerHeaders(app);

    const first = await app.inject({
      method: "POST",
      url: "/items/item-1/disconnect",
      headers: owner.headers,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: "disconnecting" });
    expect(foldAccounts(await deps.events.eventsSince("user-1", 0, 100))[0]?.status).toBe(
      "disconnected",
    );

    deps.plaid.itemRemove = async () => undefined;
    await processNextPlaidJob(
      { ...deps, jobs: deps.jobs! },
      () => new Date("2026-07-07T12:00:06.000Z"),
    );
    expect((await deps.items.get("item-1"))?.status).toBe("disconnected");
  });

  it("does not reveal or mutate another user's connection", async () => {
    const deps = await makeDeps({});
    deps.plaid.itemRemove = async () => undefined;
    const app = await buildApp(deps);
    await registerHeaders(app); // user-1
    const other = await registerHeaders(app); // user-2

    const result = await app.inject({
      method: "POST",
      url: "/items/item-1/disconnect",
      headers: other.headers,
    });
    expect(result.statusCode).toBe(404);
    expect((await deps.items.get("item-1"))?.status).toBe("ready");
  });

  it("surfaces login-required failures as user action instead of endless retry", async () => {
    const deps = await makeDeps({ "": page({}, "c1") });
    deps.plaid.transactionsSync = async () => {
      throw new PlaidApiError("login", 400, "ITEM_LOGIN_REQUIRED");
    };
    const app = await buildApp(deps);
    const owner = await registerHeaders(app);

    const result = await app.inject({
      method: "POST",
      url: "/items/item-1/refresh",
      headers: owner.headers,
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().failure).toMatchObject({
      kind: "reauth_required",
      needsUserAction: true,
    });
    expect((await deps.items.get("item-1"))?.status).toBe("reauthentication_needed");
  });

  it("records a login-required Item webhook without waiting for another bank call", async () => {
    const deps = await makeDeps({});
    const app = await buildApp(deps);
    const result = await app.inject({
      method: "POST",
      url: "/webhooks/plaid",
      payload: {
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: "item-1",
        error: { error_code: "ITEM_LOGIN_REQUIRED" },
      },
    });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toEqual({ handled: true, queued: false });
    expect(await deps.items.get("item-1")).toMatchObject({
      status: "reauthentication_needed",
    });
  });
});
