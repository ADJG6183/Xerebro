/**
 * readEnvelope is the compatibility seam between encrypted rows, legacy
 * plaintext rows (installs that predate encryption), and unreadable rows.
 * Getting it wrong silently drops a user's cached data, so it gets its own
 * tests with a real cipher.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptString,
  deriveKeys,
  encryptString,
  type CryptoPrimitives,
} from "../src/data/crypto/cipher";
import { hmacSha256 } from "../src/data/crypto/sha256";
import { readEnvelope } from "../src/data/crypto/storedEnvelope";

const primitives: CryptoPrimitives = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  hmacSha256,
};
const keys = deriveKeys(new Uint8Array(randomBytes(32)), primitives);
const cipher = {
  encrypt: (p: string) => encryptString(p, keys, primitives),
  decrypt: (b: string) => decryptString(b, keys, primitives),
};

const EVENT = { eventId: "e1", sequence: 7, type: "TransactionPosted", payload: { amountMinor: -450 } };

describe("readEnvelope", () => {
  it("reads rows written encrypted", () => {
    expect(readEnvelope(cipher.encrypt(JSON.stringify(EVENT)), cipher)).toEqual(EVENT);
  });

  it("still reads legacy PLAINTEXT rows, so upgrading never wipes the cache", () => {
    expect(readEnvelope(JSON.stringify(EVENT), cipher)).toEqual(EVENT);
  });

  it("skips unreadable rows (returns null) instead of throwing — the server re-supplies them", () => {
    expect(readEnvelope("not base64 and not json {{{", cipher)).toBeNull();

    // Written under a DIFFERENT key (e.g. keystore reset): unreadable, skipped.
    const otherKeys = deriveKeys(new Uint8Array(randomBytes(32)), primitives);
    const foreign = encryptString(JSON.stringify(EVENT), otherKeys, primitives);
    expect(readEnvelope(foreign, cipher)).toBeNull();
  });
});
