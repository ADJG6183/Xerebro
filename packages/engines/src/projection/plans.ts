/**
 * Buckets and bills: upsert-style events + folds, same convention as
 * accounts (docs/EventArchitecture.md): one event type per entity,
 * last write by server sequence wins per id. Payload shapes are the
 * DataModel.md entities the state engine already consumes.
 */
import type { EventEnvelope } from "../events";
import type { Bill, Bucket } from "../state/financialState";

export type BucketUpserted = EventEnvelope<"BucketUpserted", Bucket>;
export type BillUpserted = EventEnvelope<"BillUpserted", Bill>;

export function foldBuckets(events: readonly EventEnvelope[]): Bucket[] {
  const byId = new Map<string, Bucket>();
  for (const event of events) {
    if (event.type === "BucketUpserted") {
      const bucket = event.payload as Bucket;
      byId.set(bucket.bucketId, { ...bucket });
    }
  }
  return [...byId.values()];
}

export function foldBills(events: readonly EventEnvelope[]): Bill[] {
  const byId = new Map<string, Bill>();
  for (const event of events) {
    if (event.type === "BillUpserted") {
      const bill = event.payload as Bill;
      byId.set(bill.billId, { ...bill });
    }
  }
  return [...byId.values()];
}
