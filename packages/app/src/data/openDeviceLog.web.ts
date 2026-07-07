/**
 * Web preview: session-only in-memory log. expo-sqlite on web needs extra
 * wasm/COEP setup — deferred; the browser target is a dev convenience, not
 * the product (docs/V1Scope.md). Data still syncs down from the server on
 * every load, so the preview is functional — it just isn't offline-durable.
 */
import { InMemoryDeviceLog, type DeviceEventLog } from "./deviceLog";

export async function openDeviceLog(): Promise<DeviceEventLog> {
  return new InMemoryDeviceLog();
}
