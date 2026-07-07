/**
 * SQLite implementation of DeviceEventLog (expo-sqlite, SDK 57 async API).
 * Must behave exactly like InMemoryDeviceLog — that's the reference.
 *
 * Runtime-only: vitest never imports this file (expo-sqlite needs a native
 * runtime). Encryption-at-rest per docs/SecurityPrivacy.md is a pre-launch
 * requirement tracked for the security milestone.
 */
import * as SQLite from "expo-sqlite";
import type { EventEnvelope } from "@xerebro/engines";
import type { DeviceEventLog } from "./deviceLog";

export async function openSqliteDeviceLog(dbName = "xerebro.db"): Promise<DeviceEventLog> {
  const db = await SQLite.openDatabaseAsync(dbName);
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
            JSON.stringify(event),
          );
        }
      });
    },

    async all() {
      const rows = await db.getAllAsync<{ envelope: string }>(
        "SELECT envelope FROM events ORDER BY sequence ASC",
      );
      return rows.map((r) => JSON.parse(r.envelope) as EventEnvelope);
    },
  };
}
