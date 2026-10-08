/**
 * Device projection cache: keeps the folded snapshot in memory so a render
 * folds only what arrived since the last one (ADR-003 permits materialized
 * projections precisely because rebuild-from-log always remains possible).
 *
 * Before: every render read the whole log and folded it — O(all history).
 * After:  the first render folds history once; later renders fold only the
 *         delta — O(new events).
 *
 * Correctness rests on advanceSnapshot's property test (incremental ===
 * rebuild). The cache adds only bookkeeping: which sequence we're at, and a
 * rebuild path for the one case where incremental folding is invalid.
 */
import {
  advanceSnapshot,
  emptySnapshot,
  type EventEnvelope,
  type ProjectionSnapshot,
} from "@xerebro/engines";
import type { DeviceEventLog } from "./deviceLog";

export interface ProjectionCache {
  /** Snapshot of committed events, folding only what's new since last call. */
  current(log: DeviceEventLog): Promise<ProjectionSnapshot>;
  /** Snapshot including queued outbox events, for optimistic rendering. */
  withPending(
    log: DeviceEventLog,
    pending: readonly Omit<EventEnvelope, "sequence">[],
  ): Promise<ProjectionSnapshot>;
  /** Drop the cache; the next read re-folds from the log. */
  invalidate(): void;
}

export function createProjectionCache(): ProjectionCache {
  let snapshot = emptySnapshot();
  /** Idempotency keys already committed — lets us drop outbox entries that
   * the server has accepted but the outbox hasn't dequeued yet (the
   * flush-then-pull window), exactly like outbox.withPending does. */
  let committedKeys = new Set<string>();

  async function current(log: DeviceEventLog): Promise<ProjectionSnapshot> {
    const latest = await log.lastSequence();
    if (latest === snapshot.lastSequence) return snapshot; // nothing new: free
    if (latest < snapshot.lastSequence) {
      snapshot = emptySnapshot(); // log shrank (reset/rebuild)
      committedKeys = new Set();
    }

    // Indexed delta read (deviceLog.ts): only events past what's already
    // folded are loaded/decrypted at all, not just folded — this is the
    // O(new events) read the comment above promises, not O(all history).
    const events = await log.since(snapshot.lastSequence);
    for (const e of events) committedKeys.add(e.idempotencyKey);
    snapshot = advanceSnapshot(snapshot, events);
    return snapshot;
  }

  return {
    current,
    async withPending(log, pending) {
      const committed = await current(log);
      const unsynced = pending.filter((e) => !committedKeys.has(e.idempotencyKey));
      if (unsynced.length === 0) return committed;
      // Provisional sequences continue past the committed tail — rendering
      // only, never persisted (outbox.ts withPending has the same rule).
      const provisional = unsynced.map((e, i) => ({
        ...e,
        sequence: committed.lastSequence + i + 1,
      })) as EventEnvelope[];
      // Derived from `committed` and returned, never assigned to `snapshot`:
      // pending events are not canonical and must not pollute the cache.
      return advanceSnapshot(committed, provisional);
    },
    invalidate() {
      snapshot = emptySnapshot();
      committedKeys = new Set();
    },
  };
}
