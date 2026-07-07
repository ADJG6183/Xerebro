/**
 * Event envelope and the transaction slice of the catalog (docs/adr/ADR-003-events.md).
 * The log is append-only; `sequence` is server-assigned and is THE global order.
 * Remaining catalog types (buckets, goals, detectors) arrive with their subsystems.
 */
import type { MinorUnits } from "./money.js";

export type EventSource = "plaid" | "user" | "system" | "detector";

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  eventId: string;
  /** Server-assigned, gapless per user. Devices never invent global order (ADR-001). */
  sequence: number;
  type: TType;
  schemaVersion: number;
  /** ISO 8601 UTC. Calendar concepts use local dates elsewhere (docs/DataModel.md). */
  occurredAt: string;
  source: EventSource;
  idempotencyKey: string;
  payload: TPayload;
}

export type TransactionStatus = "pending" | "posted";
export type CategorySource = "plaid" | "model" | "user";

export interface TransactionPostedPayload {
  txnId: string;
  accountId: string;
  /** Signed: negative = outflow. */
  amountMinor: MinorUnits;
  currency: string;
  status: TransactionStatus;
  /** Local dates (YYYY-MM-DD), evaluated in the user's timezone. */
  postedDate?: string;
  authorizedDate?: string;
  merchantRaw: string;
  category?: string;
  categorySource: CategorySource;
}

/** Pending→posted arrives as an update on the SAME canonical txnId (ADR-003). */
export interface TransactionUpdatedPayload {
  txnId: string;
  changes: Partial<Omit<TransactionPostedPayload, "txnId" | "accountId">>;
}

export interface TransactionRemovedPayload {
  txnId: string;
  reason?: string;
}

/** User overlay; survives upstream TransactionUpdated (docs/DataModel.md). */
export interface TransactionAnnotatedPayload {
  txnId: string;
  categoryOverride?: string;
  note?: string;
  renamedMerchant?: string;
}

export type TransactionPosted = EventEnvelope<"TransactionPosted", TransactionPostedPayload>;
export type TransactionUpdated = EventEnvelope<"TransactionUpdated", TransactionUpdatedPayload>;
export type TransactionRemoved = EventEnvelope<"TransactionRemoved", TransactionRemovedPayload>;
export type TransactionAnnotated = EventEnvelope<"TransactionAnnotated", TransactionAnnotatedPayload>;

export type TransactionEvent =
  | TransactionPosted
  | TransactionUpdated
  | TransactionRemoved
  | TransactionAnnotated;
