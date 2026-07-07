/**
 * The device's replica of the user's event log (ADR-001: the device holds a
 * synced window of the server-ordered log and folds it into state locally).
 *
 * v1 keeps it simple and invariant-preserving: store the raw events, fold on
 * load with the engines' reference fold. Materialized projection tables come
 * later if event counts make load-time folding slow — that optimization can't
 * change behavior because rebuild-from-log is the defining guarantee.
 *
 * InMemoryDeviceLog is the reference implementation; SqliteDeviceLog
 * (sqliteLog.ts) must match it and runs only in the app runtime.
 */
import type { EventEnvelope } from "@xerebro/engines";

export interface DeviceEventLog {
  /** Highest server sequence stored; 0 when empty. */
  lastSequence(): Promise<number>;
  /** Append server-sequenced events (idempotent per sequence). */
  append(events: readonly EventEnvelope[]): Promise<void>;
  /** All stored events, ascending by sequence. */
  all(): Promise<EventEnvelope[]>;
}

export class InMemoryDeviceLog implements DeviceEventLog {
  private readonly bySequence = new Map<number, EventEnvelope>();

  async lastSequence(): Promise<number> {
    let max = 0;
    for (const seq of this.bySequence.keys()) if (seq > max) max = seq;
    return max;
  }

  async append(events: readonly EventEnvelope[]): Promise<void> {
    for (const event of events) {
      if (!this.bySequence.has(event.sequence)) this.bySequence.set(event.sequence, event);
    }
  }

  async all(): Promise<EventEnvelope[]> {
    return [...this.bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  }
}
