/**
 * Device sync client (ADR-001): pull the delta down by sequence; push user
 * actions up with producer idempotency keys. Transport is injected — tests
 * drive the REAL server via fastify.inject; the app runtime uses HTTP.
 *
 * No method takes a userId: identity travels in the transport's auth token
 * and the SERVER derives the user from it (SecurityPrivacy.md trust
 * boundary). A client that could name its user could name anyone's.
 */
import type { ContinuityCommand, EventEnvelope } from "@xerebro/engines";
import type { CopilotAnswer } from "./chat";
import type { DeviceEventLog } from "./deviceLog";
import type { Outbox } from "./outbox";
import { withTimeout } from "./withTimeout";

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
  /** Ask the server whether a Hosted Link session finished (no redirect). */
  completeLink?(linkToken: string): Promise<{ linked: boolean; itemId?: string }>;
  listItems?(): Promise<{ items: ConnectedItem[] }>;
  reviewAccountHistory?(command: ContinuityCommand): Promise<void>;
  disconnectItem?(itemId: string): Promise<{ status: ConnectedItem["status"]; message?: string }>;
}

export interface ConnectedItem {
  itemId: string;
  status:
    | "importing"
    | "ready"
    | "retry_needed"
    | "reauthentication_needed"
    | "disconnecting"
    | "disconnected";
  message?: string;
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
 *
 * The flush attempt is bounded: once the event is durably enqueued, this
 * must not make a caller on an interactive path (a purchase check's audit
 * write, a manual edit) wait on an unbounded network round trip
 * (performanceBudget.md). A slow/dead network reports "queued" within
 * `flushTimeoutMs` instead of up to the transport's own generic timeout
 * (httpTransport.ts, currently 8s per call — postEvents + pullOnce can both
 * be slow, compounding). The abandoned flush is NOT cancelled (plain
 * promises can't be) — it keeps running in the background and still
 * completes the outbox drain when the network allows; flushOutbox's own
 * per-outbox mutex (flushTails below) makes that safe to overlap with any
 * later call here.
 */
export async function sendOrQueue(
  transport: SyncTransport,
  log: DeviceEventLog,
  outbox: Outbox,
  events: readonly Omit<EventEnvelope, "sequence">[],
  flushTimeoutMs = 3_000,
): Promise<SubmitResult> {
  await outbox.enqueue(events);
  try {
    const flushed = await withTimeout(flushOutbox(transport, log, outbox), flushTimeoutMs);
    return { status: flushed.pending === 0 ? "synced" : "queued" };
  } catch {
    return { status: "queued" };
  }
}

export interface FlushResult {
  flushed: number;
  pending: number;
}

/** One drain at a time per durable queue. This avoids two UI/network triggers
 * racing over the same snapshot and reporting contradictory pending counts. */
const flushTails = new WeakMap<Outbox, Promise<void>>();

/**
 * Drain the outbox: one POST for the whole queue (server-side batch key +
 * producer idempotency keys make retries after ambiguous failures safe),
 * pull the server-sequenced copies, then dequeue. Upload acknowledgement is
 * not enough: if the following download fails, removing first would make a
 * financial action disappear from both the log and the optimistic view.
 */
export async function flushOutbox(
  transport: SyncTransport,
  log: DeviceEventLog,
  outbox: Outbox,
): Promise<FlushResult> {
  const previous = flushTails.get(outbox) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => flushOutboxUnlocked(transport, log, outbox));
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  flushTails.set(outbox, tail);
  try {
    return await operation;
  } finally {
    if (flushTails.get(outbox) === tail) flushTails.delete(outbox);
  }
}

async function flushOutboxUnlocked(
  transport: SyncTransport,
  log: DeviceEventLog,
  outbox: Outbox,
): Promise<FlushResult> {
  const queued = await outbox.all();
  if (queued.length === 0) return { flushed: 0, pending: 0 };
  try {
    await transport.postEvents(queued);
    await pullOnce(transport, log);
    await outbox.remove(queued.map((e) => e.idempotencyKey));
    return { flushed: queued.length, pending: await outbox.size() };
  } catch {
    return { flushed: 0, pending: await outbox.size() };
  }
}
