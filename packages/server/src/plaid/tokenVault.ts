/**
 * Custody for Plaid access tokens (docs/SecurityPrivacy.md: "Plaid access
 * tokens live server-side only… column-level encryption… token rotation on
 * any suspected compromise").
 *
 * An access token is a bearer credential for someone's bank data — the most
 * sensitive secret we hold. Two rules follow:
 *  1. it NEVER leaves the server (no API response, no log, no event payload);
 *  2. it is encrypted before it touches the database, with a key from the
 *     environment (a managed KMS in deployment), so a stolen database dump
 *     yields ciphertext.
 *
 * AES-256-GCM here because Node has it natively — unlike the device, which
 * had to compose CTR+HMAC for lack of native AES in Expo Go.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const ALGORITHM = "aes-256-gcm";

export interface TokenVault {
  seal(accessToken: string): string;
  open(sealed: string): string;
}

export class TokenVaultError extends Error {}

/**
 * Build a vault from a base64 32-byte key (PLAID_TOKEN_KEY).
 * Generate one with: openssl rand -base64 32
 */
export function createTokenVault(base64Key: string): TokenVault {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new TokenVaultError("PLAID_TOKEN_KEY must be a base64-encoded 32-byte key");
  }

  return {
    seal(accessToken) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(accessToken, "utf8"), cipher.final()]);
      // iv || tag || ciphertext — self-describing, single column.
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    },

    open(sealed) {
      const bytes = Buffer.from(sealed, "base64");
      if (bytes.length < IV_BYTES + 16) throw new TokenVaultError("sealed token is malformed");
      const iv = bytes.subarray(0, IV_BYTES);
      const tag = bytes.subarray(IV_BYTES, IV_BYTES + 16);
      const ciphertext = bytes.subarray(IV_BYTES + 16);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // Wrong key or tampered data — GCM's authentication caught it.
        throw new TokenVaultError("failed to decrypt access token");
      }
    },
  };
}

/**
 * Dev fallback when no key is configured: stores tokens as-is. Loud by name
 * so it can never be mistaken for the real thing in a deployment review.
 */
export const PLAINTEXT_DEV_VAULT: TokenVault = {
  seal: (t) => t,
  open: (t) => t,
};
