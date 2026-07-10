/**
 * Buckets and bills: upsert-style events + folds, same convention as
 * accounts (docs/EventArchitecture.md): one event type per entity,
 * last write by server sequence wins per id. Payload shapes are the
 * DataModel.md entities the state engine already consumes.
 */
import type { EventEnvelope } from "../events";
import type { Bill, Bucket } from "../state/financialState";
import { validateEventPayload } from "../validation";

export type BucketUpserted = EventEnvelope<"BucketUpserted", Bucket>;
export type BillUpserted = EventEnvelope<"BillUpserted", Bill>;

// Both folds skip malformed payloads (poison-pill defense, validation.ts):
// a float allocatedMinor must never brick computeFinancialState.

export function foldBuckets(events: readonly EventEnvelope[]): Bucket[] {
  const byId = new Map<string, Bucket>();
  for (const event of events) {
    if (event.type !== "BucketUpserted") continue;
    if (validateEventPayload(event.type, event.payload).length > 0) continue;
    const bucket = event.payload as Bucket;
    byId.set(bucket.bucketId, { ...bucket });
  }
  return [...byId.values()];
}

export function foldBills(events: readonly EventEnvelope[]): Bill[] {
  const byId = new Map<string, Bill>();
  for (const event of events) {
    if (event.type !== "BillUpserted") continue;
    if (validateEventPayload(event.type, event.payload).length > 0) continue;
    const bill = event.payload as Bill;
    byId.set(bill.billId, { ...bill });
  }
  return [...byId.values()];
}
