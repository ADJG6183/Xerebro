/**
 * Platform wiring for at-rest encryption (docs/SecurityPrivacy.md).
 *
 * The 256-bit master key is generated once on first launch with the
 * platform's CSPRNG (expo-crypto) and stored in the hardware-backed keystore
 * (iOS Keychain / Android Keystore via expo-secure-store) — never in app
 * storage, never in the database it protects, never synced to our server.
 *
 * Consequence worth knowing: the key is device-local. If the keystore entry
 * is lost (app uninstalled, device wiped), the local cache is unreadable —
 * which is FINE by design: the server holds the canonical event log
 * (ADR-001), so the device re-syncs from scratch. Losing a cache is not
 * losing data.
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  decryptString,
  deriveKeys,
  encryptString,
  fromBase64,
  toBase64,
  type CryptoPrimitives,
  type DeviceCipher,
  type DerivedKeys,
} from "./cipher";
import { hmacSha256 } from "./sha256";

export type { DeviceCipher };

const KEY_ITEM = "xerebro.db.masterKey.v1";

export const devicePrimitives: CryptoPrimitives = {
  randomBytes: (length) => Crypto.getRandomBytes(length),
  hmacSha256,
};

/** Load the master key from the keystore, generating it on first launch. */
export async function loadOrCreateMasterKey(): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(KEY_ITEM);
  if (existing) return fromBase64(existing);

  const key = Crypto.getRandomBytes(32);
  await SecureStore.setItemAsync(KEY_ITEM, toBase64(key), {
    // Only readable while the device is unlocked: a powered-off stolen phone
    // yields nothing, even to someone with the filesystem.
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return key;
}

export function cipherFromKeys(keys: DerivedKeys): DeviceCipher {
  return {
    encrypt: (plaintext) => encryptString(plaintext, keys, devicePrimitives),
    decrypt: (blob) => decryptString(blob, keys, devicePrimitives),
  };
}

/** The app's device cipher: keystore key → derived keys → encrypt/decrypt. */
export async function openDeviceCipher(): Promise<DeviceCipher> {
  const master = await loadOrCreateMasterKey();
  return cipherFromKeys(deriveKeys(master, devicePrimitives));
}
