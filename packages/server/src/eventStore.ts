/**
 * Event log store (docs/adr/ADR-003-events.md).
 *
 * The server owns the ONLY global order: `sequence` is assigned here,
 * gapless per user, at append time. Devices sync by sequence (ADR-001)
 * and never invent order themselves.
 *
 * Idempotency happens at two levels:
 *  - batch keys: one webhook fetch = one batch key `(itemId, cursor)`;
 *    replaying the same fetch appends nothing (docs/verificationEngine.md
 *    warned this is where duplicate-transaction bugs are born)
 *  - per-event producer idempotency keys, for user events sent up from devices
 *
 * InMemoryEventStore is the reference implementation the Postgres adapter
 * must match (same pattern as the engines' reference fold). Not durable —
 * a process restart loses it; fine until the Postgres milestone.
 */
import type { EventEnvelope } from "@xerebro/engines";

/** What producers hand the store — sequence does not exist yet. */
export type UnsequencedEvent = Omit<EventEnvelope, "sequence">;

export interface AppendResult {
  appended: EventEnvelope[];
  /** True when the batch key had already been processed (full no-op). */
  deduped: boolean;
}

export interface EventStore {
  appendBatch(
    userId: string,
    events: readonly UnsequencedEvent[],
    batchKey: string,
  ): Promise<AppendResult>;
  /** Delta sync: events with sequence > since, oldest first. */
  eventsSince(userId: string, since: number, limit?: number): Promise<EventEnvelope[]>;
  lastSequence(userId: string): Promise<number>;
}

export class InMemoryEventStore implements EventStore {
  private readonly logs = new Map<string, EventEnvelope[]>();
  private readonly processedBatchKeys = new Map<string, Set<string>>();
  private readonly seenIdempotencyKeys = new Map<string, Set<string>>();

  async appendBatch(
    userId: string,
    events: readonly UnsequencedEvent[],
    batchKey: string,
  ): Promise<AppendResult> {
    const batches = getOrInit(this.processedBatchKeys, userId, () => new Set<string>());
    if (batches.has(batchKey)) return { appended: [], deduped: true };

    const log = getOrInit(this.logs, userId, () => []);
    const seen = getOrInit(this.seenIdempotencyKeys, userId, () => new Set<string>());

    const appended: EventEnvelope[] = [];
    for (const event of events) {
      if (seen.has(event.idempotencyKey)) continue; // duplicate producer send
      seen.add(event.idempotencyKey);
      const sequenced: EventEnvelope = { ...event, sequence: log.length + 1 };
      log.push(sequenced);
      appended.push(sequenced);
    }
    batches.add(batchKey);
    return { appended, deduped: false };
  }

  async eventsSince(userId: string, since: number, limit = 500): Promise<EventEnvelope[]> {
    const log = this.logs.get(userId) ?? [];
    // sequence is gapless and 1-based, so `since` is also an index offset.
    // Clamp: a negative `since` must mean "from the beginning" exactly as it
    // does in the Postgres adapter (WHERE sequence > $2) — contract-tested.
    const from = Math.max(0, since);
    return log.slice(from, from + limit);
  }

  async lastSequence(userId: string): Promise<number> {
    return this.logs.get(userId)?.length ?? 0;
  }
}

function getOrInit<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = init();
    map.set(key, value);
  }
  return value;
}
