/**
 * Device sync client (ADR-001): pull the delta down by sequence; push user
 * actions up with producer idempotency keys. Transport is injected — tests
 * drive the REAL server via fastify.inject; the app runtime uses HTTP.
 */
import type { EventEnvelope } from "@xerebro/engines";
import type { DeviceEventLog } from "./deviceLog";

export interface SyncTransport {
  getEventsSince(
    userId: string,
    since: number,
  ): Promise<{ events: EventEnvelope[]; lastSequence: number }>;
  postEvents(userId: string, events: readonly Omit<EventEnvelope, "sequence">[]): Promise<void>;
}

export interface PullResult {
  pulled: number;
  lastSequence: number;
}

/** Pull pages until the device has everything the server has. */
export async function pullOnce(
  transport: SyncTransport,
  log: DeviceEventLog,
  userId: string,
): Promise<PullResult> {
  let pulled = 0;
  for (;;) {
    const since = await log.lastSequence();
    const page = await transport.getEventsSince(userId, since);
    if (page.events.length === 0) return { pulled, lastSequence: since };
    await log.append(page.events);
    pulled += page.events.length;
  }
}

/**
 * Push a user action up, then pull, so the device's log contains the
 * server-sequenced version of its own event (one source of order, ADR-003).
 */
export async function pushUserEvents(
  transport: SyncTransport,
  log: DeviceEventLog,
  userId: string,
  events: readonly Omit<EventEnvelope, "sequence">[],
): Promise<PullResult> {
  await transport.postEvents(userId, events);
  return pullOnce(transport, log, userId);
}
