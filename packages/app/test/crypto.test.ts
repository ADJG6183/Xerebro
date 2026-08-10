/**
 * At-rest encryption tests (docs/SecurityPrivacy.md).
 *
 * Security-critical code gets three kinds of check:
 *  1. KNOWN-ANSWER vectors — our SHA-256/HMAC must match the published
 *     standards exactly, verified independently against Node's crypto;
 *  2. PROPERTY tests — round-trip fidelity over arbitrary input;
 *  3. ADVERSARIAL tests — tampering, truncation, and wrong keys must be
 *     REJECTED, never silently mis-decrypted.
 */
import { createHash, createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { hmacSha256, sha256 } from "../src/data/crypto/sha256";
import {
  DecryptionError,
  decryptString,
  deriveKeys,
  encryptString,
  fromBase64,
  timingSafeEqual,
  toBase64,
  utf8,
  type CryptoPrimitives,
} from "../src/data/crypto/cipher";

const primitives: CryptoPrimitives = {
  randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
  hmacSha256,
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("SHA-256 (known-answer vectors)", () => {
  it("matches the published FIPS 180-4 vectors", () => {
    expect(hex(sha256(utf8("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("PROPERTY: agrees with Node's crypto for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        expect(hex(sha256(utf8(s)))).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
      }),
    );
  });
});

describe("HMAC-SHA256 (known-answer vectors)", () => {
  it("matches RFC 4231 test case 2", () => {
    const mac = hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?"));
    expect(hex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("PROPERTY: agrees with Node's HMAC, including oversized keys", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 100 }),
        fc.string({ maxLength: 300 }),
        (key, message) => {
          const ours = hex(hmacSha256(key, utf8(message)));
          const node = createHmac("sha256", Buffer.from(key)).update(message, "utf8").digest("hex");
          expect(ours).toBe(node);
        },
      ),
    );
  });
});

describe("base64 round-trip", () => {
  it("PROPERTY: matches Node's base64 for arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
        expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
      }),
    );
  });
});

describe("authenticated encryption at rest", () => {
  const master = new Uint8Array(nodeRandomBytes(32));
  const keys = deriveKeys(master, primitives);

  it("PROPERTY: decrypt(encrypt(x)) === x for arbitrary payloads", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (plaintext) => {
        expect(decryptString(encryptString(plaintext, keys, primitives), keys, primitives)).toBe(
          plaintext,
        );
      }),
    );
  });

  it("hides the plaintext: a realistic event payload is unreadable on disk", () => {
    const event = JSON.stringify({
      type: "TransactionPosted",
      payload: { merchantRaw: "SECRET-MERCHANT", amountMinor: -12_345 },
    });
    const blob = encryptString(event, keys, primitives);
    expect(blob).not.toContain("SECRET-MERCHANT");
    expect(blob).not.toContain("TransactionPosted");
    expect(blob).not.toContain("12345");
  });

  it("same plaintext encrypts differently every time (fresh IV, no pattern leak)", () => {
    const a = encryptString("same text", keys, primitives);
    const b = encryptString("same text", keys, primitives);
    expect(a).not.toBe(b);
    expect(decryptString(a, keys, primitives)).toBe(decryptString(b, keys, primitives));
  });

  it("derives DISTINCT encryption and MAC keys from one master key", () => {
    expect(hex(keys.encryptionKey)).not.toBe(hex(keys.macKey));
    expect(keys.encryptionKey.length).toBe(32);
    expect(keys.macKey.length).toBe(32);
  });

  it("ADVERSARIAL: a tampered blob is rejected, never silently decrypted", () => {
    const blob = encryptString("balance is $5,000.00", keys, primitives);
    const bytes = fromBase64(blob);
    bytes[IV_OFFSET_INTO_CIPHERTEXT] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptString(toBase64(bytes), keys, primitives)).toThrow(DecryptionError);
  });

  it("ADVERSARIAL: truncation is rejected", () => {
    const blob = encryptString("some data", keys, primitives);
    const bytes = fromBase64(blob);
    expect(() => decryptString(toBase64(bytes.slice(0, bytes.length - 4)), keys, primitives)).toThrow(
      DecryptionError,
    );
    expect(() => decryptString(toBase64(new Uint8Array(8)), keys, primitives)).toThrow(
      DecryptionError,
    );
  });

  it("ADVERSARIAL: a different key cannot read the data", () => {
    const blob = encryptString("private", keys, primitives);
    const otherKeys = deriveKeys(new Uint8Array(nodeRandomBytes(32)), primitives);
    expect(() => decryptString(blob, otherKeys, primitives)).toThrow(DecryptionError);
  });

  it("rejects a master key of the wrong size", () => {
    expect(() => deriveKeys(new Uint8Array(16), primitives)).toThrow(/32 bytes/);
  });
});

describe("timingSafeEqual", () => {
  it("compares by value and rejects length mismatches", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

/** One byte inside the ciphertext region (past the 16-byte IV). */
const IV_OFFSET_INTO_CIPHERTEXT = 20;
