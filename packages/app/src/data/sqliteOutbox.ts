/**
 * SQLite outbox (native only; web uses InMemoryOutbox — same split and same
 * reasons as openDeviceLog). Must behave exactly like InMemoryOutbox.
 * Shares the device database file with the event log.
 *
 * ENCRYPTED AT REST, same construction as the event log
 * (docs/SecurityPrivacy.md). The idempotency key stays in the clear: it is
 * the UNIQUE index that makes re-tap deduplication work, and it carries no
 * financial content — just a device id and an action name.
 */
import * as SQLite from "expo-sqlite";
import type { OutgoingEvent } from "./userEvents";
import type { Outbox } from "./outbox";
import type { DeviceCipher } from "./crypto/cipher";
import { openDeviceCipher } from "./crypto/deviceCipher";
import { readEnvelope } from "./crypto/storedEnvelope";

export async function openSqliteOutbox(dbName = "xerebro.db"): Promise<Outbox> {
  const db = await SQLite.openDatabaseAsync(dbName);
  const cipher: DeviceCipher = await openDeviceCipher();
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS outbox (
       rowid_order INTEGER PRIMARY KEY AUTOINCREMENT,
       idempotency_key TEXT NOT NULL UNIQUE,
       envelope TEXT NOT NULL
     );`,
  );

  return {
    async enqueue(events) {
      await db.withTransactionAsync(async () => {
        for (const event of events) {
          await db.runAsync(
            "INSERT OR IGNORE INTO outbox (idempotency_key, envelope) VALUES (?, ?)",
            event.idempotencyKey,
            cipher.encrypt(JSON.stringify(event)),
          );
        }
      });
    },

    async all() {
      const rows = await db.getAllAsync<{ envelope: string }>(
        "SELECT envelope FROM outbox ORDER BY rowid_order ASC",
      );
      return rows
        .map((r) => readEnvelope<OutgoingEvent>(r.envelope, cipher))
        .filter((e): e is OutgoingEvent => e !== null);
    },

    async remove(idempotencyKeys) {
      await db.withTransactionAsync(async () => {
        for (const key of idempotencyKeys) {
          await db.runAsync("DELETE FROM outbox WHERE idempotency_key = ?", key);
        }
      });
    },

    async size() {
      const row = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
      return row?.n ?? 0;
    },
  };
}
