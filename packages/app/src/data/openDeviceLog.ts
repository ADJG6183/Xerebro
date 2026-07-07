/**
 * Native (iOS/Android): durable SQLite log — the real local-first store.
 * Metro picks this file for native builds and openDeviceLog.web.ts for web,
 * so each bundle only contains the storage it can actually run.
 */
import type { DeviceEventLog } from "./deviceLog";
import { openSqliteDeviceLog } from "./sqliteLog";

export function openDeviceLog(): Promise<DeviceEventLog> {
  return openSqliteDeviceLog();
}
