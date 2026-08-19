/**
 * Device sync client (ADR-001): pull the delta down by sequence; push user
 * actions up with producer idempotency keys. Transport is injected — tests
 * drive the REAL server via fastify.inject; the app runtime uses HTTP.
 *
 * No method takes a userId: identity travels in the transport's auth token
 * and the SERVER derives the user from it (SecurityPrivacy.md trust
 * boundary). A client that could name its user could name anyone's.
 */
import type { EventEnvelope } from "@xerebro/engines";
import type { CopilotAnswer } from "./chat";
import type { DeviceEventLog } from "./deviceLog";
import type { Outbox } from "./outbox";

export interface SyncTransport {
  getEventsSince(since: number): Promise<{ events: EventEnvelope[]; lastSequence: number }>;
  postEvents(events: readonly Omit<EventEnvelope, "sequence">[]): Promise<void>;
  /** On-demand aggregator refresh (verification refresh-race). Optional:
   * absent means the deployment has no aggregator (manual-only). */
  refreshItem?(itemId: string): Promise<void>;
  /** LLM explanation via the server proxy. Optional: absent or failing means
   * the template explanation stands (docs/AIArchitecture.md fallback). */
  getExplanation?(request: unknown): Promise<{
    text: string;
    provider: string;
    model: string;
    promptTemplateVersion: string;
  }>;
  /** Copilot chat via the server (docs/copilotArchitecture.md). */
  chat?(question: string, todayLocal: string): Promise<CopilotAnswer>;
  /** Bank linking (docs/SecurityPrivacy.md). Absent/failing = manual-only.
   * The ACCESS token never comes back here — only the item id. */
  createLinkToken?(): Promise<{
    linkToken: string;
    expiration: string;
    hostedLinkUrl?: string;
  }>;
  exchangePublicToken?(publicToken: string): Promise<{ itemId: string }>;
}

export interface PullResult {
  pulled: number;
  lastSequence: number;
}

/** Pull pages until the device has everything the server has. */
export async function pullOnce(transport: SyncTransport, log: DeviceEventLog): Promise<PullResult> {
  let pulled = 0;
  for (;;) {
    const since = await log.lastSequence();
    const page = await transport.getEventsSince(since);
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
  events: readonly Omit<EventEnvelope, "sequence">[],
): Promise<PullResult> {
  await transport.postEvents(events);
  return pullOnce(transport, log);
}

export interface SubmitResult {
  /** "synced" = on the server now; "queued" = durable locally, flushes later. */
  status: "synced" | "queued";
}

/**
 * The offline-safe write path: queue first (durable), then try to flush.
 * A dead network downgrades the result to "queued" — the action is never
 * lost, and the UI can render it optimistically via withPending().
 */
export async function sendOrQueue(
  transport: SyncTransport,
  log: DeviceEventLog,
  outbox: Outbox,
  events: readonly Omit<EventEnvelope, "sequence">[],
): Promise<SubmitResult> {
  await outbox.enqueue(events);
  const flushed = await flushOutbox(transport, log, outbox);
  return { status: flushed.pending === 0 ? "synced" : "queued" };
}

export interface FlushResult {
  flushed: number;
  pending: number;
}

/**
 * Drain the outbox: one POST for the whole queue (server-side batch key +
 * producer idempotency keys make retries after ambiguous failures safe),
 * dequeue on success, then pull so the log holds the server-sequenced
 * versions. On any network failure everything simply stays queued.
 */
export async function flushOutbox(
  transport: SyncTransport,
  log: DeviceEventLog,
  outbox: Outbox,
): Promise<FlushResult> {
  const queued = await outbox.all();
  if (queued.length === 0) return { flushed: 0, pending: 0 };
  try {
    await transport.postEvents(queued);
    await outbox.remove(queued.map((e) => e.idempotencyKey));
    await pullOnce(transport, log);
    return { flushed: queued.length, pending: await outbox.size() };
  } catch {
    return { flushed: 0, pending: queued.length };
  }
}
