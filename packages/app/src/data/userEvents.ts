/**
 * Builders for events a device sends up (source "user" — the server rejects
 * anything else from this path). Id/clock are injectable so tests stay
 * deterministic; the app runtime passes real ones.
 */
import type { Account, Bill, Bucket, EventEnvelope, TransactionPostedPayload } from "@xerebro/engines";

export interface EventFactoryDeps {
  newId: () => string;
  nowIso: () => string;
  deviceId: string;
}

export type OutgoingEvent = Omit<EventEnvelope, "sequence">;

export function makeUserEvent(
  deps: EventFactoryDeps,
  type: string,
  payload: unknown,
  /** Stable per action — resending after a dropped connection must dedupe. */
  actionKey: string,
): OutgoingEvent {
  return {
    eventId: deps.newId(),
    type,
    schemaVersion: 1,
    occurredAt: deps.nowIso(),
    source: "user",
    idempotencyKey: `${deps.deviceId}:${actionKey}`,
    payload,
  };
}

export function accountUpserted(deps: EventFactoryDeps, account: Account): OutgoingEvent {
  return makeUserEvent(deps, "AccountUpserted", account, `account:${account.accountId}`);
}

export function manualTransaction(
  deps: EventFactoryDeps,
  payload: TransactionPostedPayload,
): OutgoingEvent {
  return makeUserEvent(deps, "TransactionPosted", payload, `txn:${payload.txnId}`);
}

export function bucketUpserted(deps: EventFactoryDeps, bucket: Bucket): OutgoingEvent {
  // Action key includes the allocation so EDITING a bucket is a new action,
  // while a re-tap of the same edit still dedupes.
  return makeUserEvent(
    deps,
    "BucketUpserted",
    bucket,
    `bucket:${bucket.bucketId}:${bucket.allocatedMinor}:${bucket.targetMinor ?? ""}`,
  );
}

export function billUpserted(deps: EventFactoryDeps, bill: Bill): OutgoingEvent {
  return makeUserEvent(
    deps,
    "BillUpserted",
    bill,
    `bill:${bill.billId}:${bill.expectedAmountMinor}:${bill.nextDue}`,
  );
}
