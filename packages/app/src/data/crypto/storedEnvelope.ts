/**
 * The compatibility seam for reading rows out of the device database.
 * Platform-free on purpose: the SQLite adapters can't be imported by tests
 * (native module), but this logic decides whether a user's cached data is
 * readable — so it lives here, where it is directly testable.
 */
import type { DeviceCipher } from "./cipher";

/**
 * Decrypt a stored blob. Tolerates two legacy/edge cases without throwing:
 *  - rows written before encryption shipped (plain JSON) — read them so an
 *    upgrade doesn't wipe the user's cache;
 *  - rows that cannot be decrypted at all — skip; the server holds the
 *    canonical log (ADR-001) and re-supplies them on the next sync.
 */
export function readEnvelope<T>(stored: string, cipher: DeviceCipher): T | null {
  try {
    return JSON.parse(cipher.decrypt(stored)) as T;
  } catch {
    try {
      return JSON.parse(stored) as T; // pre-encryption plaintext row
    } catch {
      return null; // unreadable: skip, re-sync will replace it
    }
  }
}
