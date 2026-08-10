/**
 * Authenticated encryption for data at rest on the device
 * (docs/SecurityPrivacy.md: device data is encrypted; the key lives in the
 * platform keystore, never in app storage).
 *
 * Construction: AES-256-CTR + HMAC-SHA256, encrypt-then-MAC.
 *  - AES-256-CTR provides confidentiality;
 *  - the HMAC over (iv || ciphertext) provides integrity/authenticity, so
 *    tampered or truncated blobs are REJECTED rather than silently decrypted
 *    into garbage. This is the same guarantee AES-GCM gives; we compose it
 *    manually because Expo Go has no native AES (expo-crypto is
 *    hashing + RNG only) and pure-JS AES-GCM implementations are scarcer and
 *    slower than CTR. Encrypt-then-MAC is the order cryptographers recommend.
 *  - Encryption and MAC use SEPARATE keys derived from one master key, so a
 *    weakness in one never leaks the other (key separation).
 *
 * PURE by design: all randomness and hashing is injected, so every property
 * is testable in Node without a simulator. The platform wiring lives in
 * deviceCipher.ts.
 */
import aesjs from "aes-js";

/** 16-byte initialization vector: unique per encryption, never reused. */
export const IV_BYTES = 16;
export const MAC_BYTES = 32;

export interface CryptoPrimitives {
  /** Cryptographically secure random bytes. */
  randomBytes(length: number): Uint8Array;
  /** HMAC-SHA256(key, message) → 32 bytes. */
  hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array;
}

export interface DerivedKeys {
  encryptionKey: Uint8Array; // 32 bytes
  macKey: Uint8Array; // 32 bytes
}

/** What the storage adapters need: encrypt/decrypt with keys already bound. */
export interface DeviceCipher {
  encrypt(plaintext: string): string;
  decrypt(blob: string): string;
}

/**
 * Key separation: derive distinct encryption and MAC keys from one master
 * key by HMAC-ing fixed, distinct labels (HKDF-expand, single block).
 */
export function deriveKeys(masterKey: Uint8Array, primitives: CryptoPrimitives): DerivedKeys {
  if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  return {
    encryptionKey: primitives.hmacSha256(masterKey, utf8("xerebro/enc/v1")),
    macKey: primitives.hmacSha256(masterKey, utf8("xerebro/mac/v1")),
  };
}

/**
 * Encrypt UTF-8 plaintext → base64 blob of (iv || ciphertext || mac).
 * A fresh random IV per call means identical plaintexts produce different
 * ciphertexts — no leaking "these two transactions are the same".
 */
export function encryptString(
  plaintext: string,
  keys: DerivedKeys,
  primitives: CryptoPrimitives,
): string {
  const iv = primitives.randomBytes(IV_BYTES);
  const ciphertext = aesCtr(keys.encryptionKey, iv).encrypt(utf8(plaintext));
  const mac = primitives.hmacSha256(keys.macKey, concat(iv, ciphertext));
  return toBase64(concat(iv, ciphertext, mac));
}

export class DecryptionError extends Error {}

/**
 * Decrypt a blob produced by encryptString. Throws DecryptionError if the
 * MAC does not verify — i.e. the data was tampered with, truncated, or
 * encrypted under a different key. We NEVER decrypt unauthenticated data.
 */
export function decryptString(
  blob: string,
  keys: DerivedKeys,
  primitives: CryptoPrimitives,
): string {
  const bytes = fromBase64(blob);
  if (bytes.length < IV_BYTES + MAC_BYTES) throw new DecryptionError("blob too short");

  const iv = bytes.slice(0, IV_BYTES);
  const ciphertext = bytes.slice(IV_BYTES, bytes.length - MAC_BYTES);
  const mac = bytes.slice(bytes.length - MAC_BYTES);

  const expected = primitives.hmacSha256(keys.macKey, concat(iv, ciphertext));
  if (!timingSafeEqual(mac, expected)) throw new DecryptionError("authentication failed");

  return fromUtf8(aesCtr(keys.encryptionKey, iv).decrypt(ciphertext));
}

function aesCtr(key: Uint8Array, iv: Uint8Array) {
  // CTR counter is initialized from the IV; aes-js takes it as a byte array.
  return new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(iv as unknown as number[]));
}

/** Constant-time comparison: never leak *where* a MAC differs via timing. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function utf8(s: string): Uint8Array {
  return aesjs.utils.utf8.toBytes(s);
}
export function fromUtf8(b: Uint8Array): string {
  return aesjs.utils.utf8.fromBytes(b);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without relying on Buffer/atob — identical in Node and RN. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const digit = B64.indexOf(char);
    if (digit === -1) throw new DecryptionError("invalid base64 in encrypted blob");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out.slice(0, index);
}
