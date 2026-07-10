/**
 * Offline outbox (ADR-001 write path): user actions that couldn't reach the
 * server wait here — durably on native — and flush when the network returns.
 *
 * Safety comes from two existing guarantees, not from this file:
 *  - producer idempotency keys (Milestone 2): a flush retry after an
 *    ambiguous failure can never double-apply on the server;
 *  - the server owns sequences (ADR-003): queued events get PROVISIONAL
 *    sequence numbers for optimistic rendering only, and are re-read from
 *    the server (with real sequences) after flushing.
 *
 * InMemoryOutbox is the reference and the web implementation; the SQLite
 * adapter (sqliteOutbox.ts) must behave identically.
 */
import type { EventEnvelope } from "@xerebro/engines";
import type { OutgoingEvent } from "./userEvents";

export interface Outbox {
  /** FIFO append. Duplicate idempotencyKeys are ignored (re-taps). */
  enqueue(events: readonly OutgoingEvent[]): Promise<void>;
  /** All queued events, oldest first. */
  all(): Promise<OutgoingEvent[]>;
  remove(idempotencyKeys: readonly string[]): Promise<void>;
  size(): Promise<number>;
}

export class InMemoryOutbox implements Outbox {
  private queue: OutgoingEvent[] = [];

  async enqueue(events: readonly OutgoingEvent[]): Promise<void> {
    const seen = new Set(this.queue.map((e) => e.idempotencyKey));
    for (const event of events) {
      if (!seen.has(event.idempotencyKey)) {
        seen.add(event.idempotencyKey);
        this.queue.push(event);
      }
    }
  }

  async all(): Promise<OutgoingEvent[]> {
    return [...this.queue];
  }

  async remove(idempotencyKeys: readonly string[]): Promise<void> {
    const drop = new Set(idempotencyKeys);
    this.queue = this.queue.filter((e) => !drop.has(e.idempotencyKey));
  }

  async size(): Promise<number> {
    return this.queue.length;
  }
}

/**
 * Optimistic view: committed log events + queued events wearing provisional
 * sequences AFTER the last committed one. Rendering-only — provisional
 * sequences never leave the device (the server assigns the real ones).
 */
export function withPending(
  committed: readonly EventEnvelope[],
  queued: readonly OutgoingEvent[],
): EventEnvelope[] {
  const last = committed.reduce((max, e) => Math.max(max, e.sequence), 0);
  const committedKeys = new Set(committed.map((e) => e.idempotencyKey));
  return [
    ...committed,
    ...queued
      .filter((e) => !committedKeys.has(e.idempotencyKey)) // already synced
      .map((e, i) => ({ ...e, sequence: last + i + 1 })),
  ];
}
