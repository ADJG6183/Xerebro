/**
 * Builders for events a device sends up (source "user" — the server rejects
 * anything else from this path). Id/clock are injectable so tests stay
 * deterministic; the app runtime passes real ones.
 */
import type {
  Account,
  Bill,
  BudgetPlan,
  Bucket,
  EventEnvelope,
  TransactionPostedPayload,
} from "@xerebro/engines";

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
  const eventId = deps.newId();
  return {
    eventId,
    type,
    schemaVersion: 1,
    occurredAt: deps.nowIso(),
    source: "user",
    // Retries reuse this event and key. A later edit gets a new event id even
    // when the user returns to values they used before.
    idempotencyKey: `${deps.deviceId}:${actionKey}:${eventId}`,
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
  return makeUserEvent(
    deps,
    "BucketUpserted",
    bucket,
    `bucket:${bucket.bucketId}`,
  );
}

export function billUpserted(deps: EventFactoryDeps, bill: Bill): OutgoingEvent {
  return makeUserEvent(
    deps,
    "BillUpserted",
    bill,
    `bill:${bill.billId}`,
  );
}

/**
 * A correction to one transaction's category/note (DataModel.md: "annotation
 * overlay; user layer; survives upstream updates"). Never edits the source
 * transaction — this is strictly an additive overlay event. Stable actionKey
 * like every other factory here: true per-call uniqueness comes from the
 * fresh eventId makeUserEvent folds into the idempotencyKey, so a retry of
 * THIS edit dedupes while a later, distinct edit still gets a new key.
 */
export function transactionAnnotated(
  deps: EventFactoryDeps,
  payload: { txnId: string; categoryOverride?: string; note?: string; renamedMerchant?: string },
): OutgoingEvent {
  return makeUserEvent(deps, "TransactionAnnotated", payload, `annotate:${payload.txnId}`);
}

/**
 * A monthly category limit (rocketMoneyTracker.md stage 1 #1) — distinct
 * from Bucket (reserved savings): this is a comparison target for
 * reporting only, never a cash reservation. budgetPlanId is derived
 * deterministically from (categoryId, month), never caller-chosen: editing
 * the same month's limit always upserts the same plan; a different month
 * (even for the same category) always gets a new one. Callers never see or
 * manage the id directly, which rules out accidentally reusing one month's
 * id for another.
 */
export function budgetPlanUpserted(
  deps: EventFactoryDeps,
  payload: { categoryId: string; month: string; limitMinor: number; enabled: boolean },
): OutgoingEvent {
  const budgetPlanId = `${payload.categoryId}:${payload.month}`;
  const plan: BudgetPlan = { budgetPlanId, ...payload };
  return makeUserEvent(deps, "BudgetPlanUpserted", plan, `budget:${budgetPlanId}`);
}
