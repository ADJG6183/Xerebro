/**
 * The device half of bank linking. The property that matters: the durable
 * access token never reaches the device — the app handles only the link
 * token and the short-lived public token.
 */
import { describe, expect, it } from "vitest";
import { linkBankAccount, publicTokenFrom, type WebAuthOpener } from "../src/data/plaidLink";
import type { SyncTransport } from "../src/data/syncClient";

const REDIRECT = "xerebro://plaid";

const baseTransport: SyncTransport = {
  async getEventsSince() {
    return { events: [], lastSequence: 0 };
  },
  async postEvents() {},
};

function opener(result: { type: string; url?: string }): WebAuthOpener & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open(url) {
      opened.push(url);
      return result;
    },
  };
}

describe("publicTokenFrom", () => {
  it("reads the token from query or fragment, and rejects a URL without one", () => {
    expect(publicTokenFrom("xerebro://plaid?public_token=public-sandbox-abc")).toBe(
      "public-sandbox-abc",
    );
    expect(publicTokenFrom("xerebro://plaid#public_token=tok&other=1")).toBe("tok");
    expect(publicTokenFrom("xerebro://plaid?error=exit")).toBeNull();
  });
});

describe("linkBankAccount", () => {
  it("happy path: link token → hosted Link → exchange, returning only the item id", async () => {
    const exchanged: string[] = [];
    const transport: SyncTransport = {
      ...baseTransport,
      async createLinkToken() {
        return {
          linkToken: "link-sandbox-123",
          expiration: "2026-08-14T12:00:00Z",
          hostedLinkUrl: "https://secure.plaid.com/hl/abc123",
        };
      },
      async exchangePublicToken(publicToken) {
        exchanged.push(publicToken);
        return { itemId: "item-42" };
      },
    };
    const web = opener({ type: "success", url: `${REDIRECT}?public_token=public-sandbox-xyz` });

    const outcome = await linkBankAccount(transport, web, REDIRECT);

    expect(outcome).toEqual({ status: "linked", itemId: "item-42" });
    expect(exchanged).toEqual(["public-sandbox-xyz"]); // only the SHORT-LIVED token
    // We open the URL PLAID minted — never one we build ourselves.
    expect(web.opened[0]).toBe("https://secure.plaid.com/hl/abc123");
    expect(JSON.stringify(outcome)).not.toContain("access-"); // no access token, ever
  });

  it("returns 'unavailable' when the server has no Plaid credentials", async () => {
    const noPlaid = await linkBankAccount(baseTransport, opener({ type: "cancel" }), REDIRECT);
    expect(noPlaid).toEqual({ status: "unavailable" });

    const transport: SyncTransport = {
      ...baseTransport,
      async createLinkToken() {
        throw new Error("link token failed: HTTP 503");
      },
      async exchangePublicToken() {
        return { itemId: "unused" };
      },
    };
    expect(await linkBankAccount(transport, opener({ type: "cancel" }), REDIRECT)).toEqual({
      status: "unavailable",
    });
  });

  it("treats a dismissed Link session as a cancel, not an error", async () => {
    const transport: SyncTransport = {
      ...baseTransport,
      async createLinkToken() {
        return { linkToken: "link-sandbox-123", expiration: "", hostedLinkUrl: "https://secure.plaid.com/hl/abc" };
      },
      async exchangePublicToken() {
        throw new Error("should not be called");
      },
    };
    expect(await linkBankAccount(transport, opener({ type: "dismiss" }), REDIRECT)).toEqual({
      status: "cancelled",
    });
  });

  it("reports a failed exchange without losing the user's place", async () => {
    const transport: SyncTransport = {
      ...baseTransport,
      async createLinkToken() {
        return { linkToken: "link-sandbox-123", expiration: "", hostedLinkUrl: "https://secure.plaid.com/hl/abc" };
      },
      async exchangePublicToken() {
        throw new Error("exchange failed: HTTP 502");
      },
    };
    const web = opener({ type: "success", url: `${REDIRECT}?public_token=public-sandbox-xyz` });
    const outcome = await linkBankAccount(transport, web, REDIRECT);
    expect(outcome.status).toBe("failed");
  });
});
