/**
 * The Plaid link handshake and its security properties:
 *  - the access token NEVER reaches the client, and is sealed at rest;
 *  - items belong to the user who linked them;
 *  - balances become AccountUpserted events with a freshness anchor;
 *  - absent configuration degrades to 503, never a crash.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { PlaidAccount, PlaidLinkGateway } from "../src/plaid/gateway";
import { createTokenVault, TokenVaultError } from "../src/plaid/tokenVault";
import { syncPlaidBalances } from "../src/plaid/balances";
import { toAccountType } from "../src/plaid/balances";
import { makeDeps, page, registerHeaders } from "./helpers";

const KEY = Buffer.alloc(32, 7).toString("base64");

const ACCOUNT: PlaidAccount = {
  account_id: "plaid-acct-1",
  name: "Plaid Checking",
  mask: "0000",
  type: "depository",
  subtype: "checking",
  balances: { current: 1_234.56, available: 1_200.5, iso_currency_code: "USD" },
};

function linkGateway(): PlaidLinkGateway & { exchanged: string[] } {
  const exchanged: string[] = [];
  return {
    exchanged,
    async createLinkToken(userId) {
      return { linkToken: `link-sandbox-${userId}`, expiration: "2026-08-14T12:00:00Z" };
    },
    async exchangePublicToken(publicToken) {
      exchanged.push(publicToken);
      return { accessToken: "access-sandbox-SUPER-SECRET", itemId: "item-new" };
    },
  };
}

describe("token vault", () => {
  it("seals and opens round-trip, hiding the token at rest", () => {
    const vault = createTokenVault(KEY);
    const sealed = vault.seal("access-sandbox-abc123");
    expect(sealed).not.toContain("access-sandbox");
    expect(vault.open(sealed)).toBe("access-sandbox-abc123");
  });

  it("rejects a wrong key and tampered ciphertext (GCM authentication)", () => {
    const sealed = createTokenVault(KEY).seal("access-sandbox-abc123");
    const otherVault = createTokenVault(Buffer.alloc(32, 9).toString("base64"));
    expect(() => otherVault.open(sealed)).toThrow(TokenVaultError);

    const bytes = Buffer.from(sealed, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff;
    expect(() => createTokenVault(KEY).open(bytes.toString("base64"))).toThrow(TokenVaultError);
  });

  it("refuses a key of the wrong size", () => {
    expect(() => createTokenVault(Buffer.alloc(16).toString("base64"))).toThrow(TokenVaultError);
  });
});

describe("balance mapping", () => {
  it("maps Plaid types to ours and floats to integer minor units", () => {
    expect(toAccountType("depository", "checking")).toBe("checking");
    expect(toAccountType("depository", "savings")).toBe("savings");
    expect(toAccountType("depository", "money market")).toBe("savings");
    expect(toAccountType("depository", "prepaid")).toBe("cash");
    expect(toAccountType("credit", "credit card")).toBe("credit");
    expect(toAccountType("loan", "student")).toBe("loan");
    expect(toAccountType("weird-new-type", null)).toBe("cash"); // never dropped
  });

  it("keeps LOCKED deposits out of spendable cash (real sandbox regression)", () => {
    // Plaid's sandbox returns a "Plaid CD" as depository/cd. Classified as
    // checking it would inflate available cash and skew purchase approvals.
    expect(toAccountType("depository", "cd")).toBe("investment");
    expect(toAccountType("depository", "hsa")).toBe("investment");
    expect(toAccountType("depository", "some-future-subtype")).toBe("investment");
  });

  it("emits AccountUpserted with integer money and a freshness anchor", async () => {
    const deps = await makeDeps({});
    deps.plaid.accountsBalanceGet = async () => [ACCOUNT];

    const outcome = await syncPlaidBalances(deps, "item-1");
    expect(outcome).toEqual({ accounts: 1, appended: 1 });

    const [event] = await deps.events.eventsSince("user-1", 0);
    const payload = event!.payload as Record<string, unknown>;
    expect(payload.balanceCurrentMinor).toBe(123_456); // 1234.56 → cents
    expect(payload.balanceAvailableMinor).toBe(120_050);
    expect(payload.source).toBe("plaid");
    expect(payload.plaidItemId).toBe("item-1");
    expect(payload.balanceAsOf).toBe(deps.now()); // the freshness anchor
  });
});

describe("link routes", () => {
  it("issues a link token for the authenticated user", async () => {
    const deps = await makeDeps({});
    deps.plaidLink = linkGateway();
    const app = buildApp(deps);
    const auth = await registerHeaders(app);

    const res = await app.inject({ method: "POST", url: "/plaid/link-token", headers: auth.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().linkToken).toContain(auth.userId);
  });

  it("SECURITY: exchange never returns the access token, and seals it at rest", async () => {
    // A single terminating page: the new item syncs from cursor "" and stops.
    const deps = await makeDeps({ "": page({}, "c1") });
    const gateway = linkGateway();
    deps.plaidLink = gateway;
    deps.tokens = createTokenVault(KEY);
    deps.plaid.accountsBalanceGet = async () => [ACCOUNT];
    const app = buildApp(deps);
    const auth = await registerHeaders(app);

    const res = await app.inject({
      method: "POST",
      url: "/plaid/exchange",
      headers: auth.headers,
      payload: { publicToken: "public-sandbox-xyz" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("SUPER-SECRET"); // never sent to the device
    expect(res.json().itemId).toBe("item-new");

    const stored = await deps.items.get("item-new");
    expect(stored?.userId).toBe(auth.userId); // ownership recorded
    expect(stored?.accessTokenRef).not.toContain("SUPER-SECRET"); // sealed at rest
    expect(createTokenVault(KEY).open(stored!.accessTokenRef)).toBe("access-sandbox-SUPER-SECRET");
  });

  it("requires auth, and degrades to 503 when linking isn't configured", async () => {
    const app = buildApp(await makeDeps({})); // no plaidLink
    const auth = await registerHeaders(app);

    const unauth = await app.inject({ method: "POST", url: "/plaid/link-token" });
    expect(unauth.statusCode).toBe(401);

    const unconfigured = await app.inject({
      method: "POST",
      url: "/plaid/link-token",
      headers: auth.headers,
    });
    expect(unconfigured.statusCode).toBe(503);
  });

  it("rejects an exchange with no public token", async () => {
    const deps = await makeDeps({});
    deps.plaidLink = linkGateway();
    const app = buildApp(deps);
    const auth = await registerHeaders(app);
    const res = await app.inject({
      method: "POST",
      url: "/plaid/exchange",
      headers: auth.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
