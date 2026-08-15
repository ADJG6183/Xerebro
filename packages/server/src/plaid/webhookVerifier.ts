/**
 * Real Plaid webhook verification, replacing DEV_TRUST_ALL_VERIFIER
 * (docs/SecurityPrivacy.md: "MUST be replaced with Plaid's JWT verification
 * before this port is ever internet-reachable").
 *
 * Without this, anyone who learns the URL can POST "item X updated" and make
 * us fetch — or, worse, drive behavior from forged notifications. Plaid signs
 * every webhook with ES256 and publishes the verifying key per key id.
 *
 * The protocol, and why each step matters:
 *  1. read `kid` from the JWT header, fetch that key from Plaid (cached) —
 *     Plaid rotates keys, so the key id must drive the lookup;
 *  2. verify the ES256 signature against that key — proves Plaid sent it;
 *  3. check `request_body_sha256` against a hash of the RAW body — proves
 *     the body wasn't swapped after signing. This is why the route must hash
 *     the raw bytes, not a re-serialized object: JSON round-tripping can
 *     reorder keys and silently break the hash;
 *  4. reject webhooks older than 5 minutes — bounds replay attacks.
 */
import { createHash, createPublicKey, createVerify } from "node:crypto";
import type { WebhookVerifier } from "../app";

const MAX_AGE_MS = 5 * 60 * 1000;

/** JWK as Plaid's /webhook_verification_key/get returns it. */
export interface PlaidJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid: string;
  use?: string;
  alg?: string;
}

export interface WebhookKeyFetcher {
  /** Fetch the verification key for a key id. */
  getKey(keyId: string): Promise<PlaidJwk>;
}

/** Fetches verification keys from Plaid, caching them by key id. */
export function plaidKeyFetcher(config: {
  clientId: string;
  secret: string;
  env: "sandbox" | "production";
}): WebhookKeyFetcher {
  const cache = new Map<string, PlaidJwk>();
  const baseUrl =
    config.env === "sandbox" ? "https://sandbox.plaid.com" : "https://production.plaid.com";

  return {
    async getKey(keyId) {
      const cached = cache.get(keyId);
      if (cached) return cached;

      const res = await fetch(`${baseUrl}/webhook_verification_key/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: config.clientId, secret: config.secret, key_id: keyId }),
      });
      if (!res.ok) throw new Error(`webhook key fetch failed: HTTP ${res.status}`);
      const body = (await res.json()) as { key: PlaidJwk };
      cache.set(keyId, body.key);
      return body.key;
    },
  };
}

interface JwtHeader {
  alg: string;
  kid: string;
}
interface JwtClaims {
  iat: number;
  request_body_sha256: string;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

/**
 * Verify a signed webhook. `rawBody` MUST be the exact bytes received.
 * `now` is injected so tests are deterministic.
 */
export function plaidWebhookVerifier(
  fetcher: WebhookKeyFetcher,
  now: () => number = Date.now,
): WebhookVerifier {
  return {
    async verify(headers, rawBody) {
      try {
        const token = headers["plaid-verification"];
        if (typeof token !== "string") return false;

        const [headerSegment, claimsSegment, signatureSegment] = token.split(".");
        if (!headerSegment || !claimsSegment || !signatureSegment) return false;

        const header = decodeSegment<JwtHeader>(headerSegment);
        if (header.alg !== "ES256") return false; // never accept "none" or a downgrade

        const jwk = await fetcher.getKey(header.kid);
        const key = createPublicKey({ key: jwk as never, format: "jwk" });

        // ES256 signatures are raw r||s; Node's verifier wants that as "ieee-p1363".
        const verifier = createVerify("SHA256");
        verifier.update(`${headerSegment}.${claimsSegment}`);
        verifier.end();
        const signature = Buffer.from(signatureSegment, "base64url");
        if (!verifier.verify({ key, dsaEncoding: "ieee-p1363" }, signature)) return false;

        const claims = decodeSegment<JwtClaims>(claimsSegment);
        if (now() - claims.iat * 1000 > MAX_AGE_MS) return false; // stale: replay

        const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
        return timingSafeStringEqual(bodyHash, claims.request_body_sha256);
      } catch {
        return false; // malformed anything → unverified, never a 500
      }
    },
  };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
