/**
 * Webhook verification, tested with a REAL ES256 keypair — a mocked verifier
 * would prove nothing. Signs webhooks exactly as Plaid does, then checks that
 * every tampering path is rejected.
 *
 * This closes the gap flagged since Milestone 2: DEV_TRUST_ALL_VERIFIER let
 * anyone who knew the URL forge "item updated" notifications.
 */
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { plaidWebhookVerifier, type PlaidJwk, type WebhookKeyFetcher } from "../src/plaid/webhookVerifier";
import { makeDeps, page, plaidTxn } from "./helpers";

const NOW_MS = Date.parse("2026-08-14T12:00:00.000Z");
const KID = "test-key-1";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

function jwkOf(key: KeyObject): PlaidJwk {
  return { ...(key.export({ format: "jwk" }) as unknown as PlaidJwk), kid: KID };
}

const fetcher: WebhookKeyFetcher = { async getKey() { return jwkOf(publicKey); } };

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** Sign a webhook the way Plaid does: ES256 over header.claims. */
function signWebhook(body: string, overrides: { iat?: number; bodyHash?: string; alg?: string } = {}) {
  const header = b64url(JSON.stringify({ alg: overrides.alg ?? "ES256", kid: KID, typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iat: overrides.iat ?? Math.floor(NOW_MS / 1000),
      request_body_sha256:
        overrides.bodyHash ?? createHash("sha256").update(body, "utf8").digest("hex"),
    }),
  );
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

const verifier = plaidWebhookVerifier(fetcher, () => NOW_MS);
const BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", item_id: "item-1" });

describe("plaid webhook verification", () => {
  it("accepts a genuine signed webhook", async () => {
    expect(await verifier.verify({ "plaid-verification": signWebhook(BODY) }, BODY)).toBe(true);
  });

  it("rejects a body swapped after signing (the forged-notification attack)", async () => {
    const token = signWebhook(BODY);
    const tampered = JSON.stringify({ webhook_type: "TRANSACTIONS", item_id: "item-ATTACKER" });
    expect(await verifier.verify({ "plaid-verification": token }, tampered)).toBe(false);
  });

  it("rejects a forged signature", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const header = b64url(JSON.stringify({ alg: "ES256", kid: KID }));
    const claims = b64url(
      JSON.stringify({
        iat: Math.floor(NOW_MS / 1000),
        request_body_sha256: createHash("sha256").update(BODY, "utf8").digest("hex"),
      }),
    );
    const signer = createSign("SHA256");
    signer.update(`${header}.${claims}`);
    signer.end();
    const forged = signer.sign({ key: other.privateKey, dsaEncoding: "ieee-p1363" });
    const token = `${header}.${claims}.${forged.toString("base64url")}`;
    expect(await verifier.verify({ "plaid-verification": token }, BODY)).toBe(false);
  });

  it("rejects stale webhooks (replay window)", async () => {
    const old = Math.floor(NOW_MS / 1000) - 10 * 60; // 10 minutes ago
    expect(await verifier.verify({ "plaid-verification": signWebhook(BODY, { iat: old }) }, BODY)).toBe(
      false,
    );
  });

  it("rejects algorithm downgrade and missing/garbage headers", async () => {
    expect(await verifier.verify({ "plaid-verification": signWebhook(BODY, { alg: "none" }) }, BODY)).toBe(
      false,
    );
    expect(await verifier.verify({}, BODY)).toBe(false);
    expect(await verifier.verify({ "plaid-verification": "not.a.jwt" }, BODY)).toBe(false);
  });

  it("END TO END: the route accepts a signed webhook and rejects an unsigned one", async () => {
    const deps = await makeDeps({ "": page({ added: [plaidTxn({ transaction_id: "t-1" })] }, "c1") });
    deps.webhookVerifier = verifier;
    const app = await buildApp(deps);
    const payload = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" };
    const raw = JSON.stringify(payload);

    const unsigned = await app.inject({ method: "POST", url: "/webhooks/plaid", payload });
    expect(unsigned.statusCode).toBe(401);

    const signed = await app.inject({
      method: "POST",
      url: "/webhooks/plaid",
      headers: { "plaid-verification": signWebhook(raw), "content-type": "application/json" },
      payload: raw, // raw string: the signature covers these exact bytes
    });
    expect(signed.statusCode).toBe(202);
    expect(signed.json()).toMatchObject({ handled: true, queued: true });
  });
});
