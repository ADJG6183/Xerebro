/**
 * SQLite implementation of DeviceEventLog (expo-sqlite, SDK 54 async API).
 * Must behave exactly like InMemoryDeviceLog — that's the reference.
 *
 * ENCRYPTED AT REST (docs/SecurityPrivacy.md): every envelope is stored as an
 * authenticated ciphertext blob, keyed from the device keystore
 * (crypto/deviceCipher.ts). A stolen database file yields opaque blobs, not
 * transactions. Sequence numbers stay in the clear — they're the sync
 * bookkeeping the queries index on and reveal nothing financial.
 *
 * Rows that fail to decrypt (tampered, or written under a lost key) are
 * SKIPPED rather than thrown on: the server holds the canonical log, so an
 * unreadable local row self-heals on the next sync. Poison must never brick
 * a reader (same doctrine as the fold's skip-and-warn).
 *
 * Runtime-only: vitest never imports this file (expo-sqlite needs a native
 * runtime); the crypto it depends on is exhaustively tested in
 * test/crypto.test.ts.
 */
import * as SQLite from "expo-sqlite";
import type { EventEnvelope } from "@xerebro/engines";
import type { DeviceEventLog } from "./deviceLog";
import type { DeviceCipher } from "./crypto/cipher";
import { openDeviceCipher } from "./crypto/deviceCipher";
import { readEnvelope } from "./crypto/storedEnvelope";

export async function openSqliteDeviceLog(dbName = "xerebro.db"): Promise<DeviceEventLog> {
  const db = await SQLite.openDatabaseAsync(dbName);
  const cipher: DeviceCipher = await openDeviceCipher();
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS events (
       sequence INTEGER PRIMARY KEY,
       envelope TEXT NOT NULL
     );`,
  );

  return {
    async lastSequence() {
      const row = await db.getFirstAsync<{ max: number | null }>(
        "SELECT MAX(sequence) AS max FROM events",
      );
      return row?.max ?? 0;
    },

    async append(events) {
      await db.withTransactionAsync(async () => {
        for (const event of events) {
          await db.runAsync(
            "INSERT OR IGNORE INTO events (sequence, envelope) VALUES (?, ?)",
            event.sequence,
            cipher.encrypt(JSON.stringify(event)),
          );
        }
      });
    },

    async all() {
      const rows = await db.getAllAsync<{ envelope: string }>(
        "SELECT envelope FROM events ORDER BY sequence ASC",
      );
      return rows
        .map((r) => readEnvelope<EventEnvelope>(r.envelope, cipher))
        .filter((e): e is EventEnvelope => e !== null);
    },
  };
}

