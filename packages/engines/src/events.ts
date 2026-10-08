/**
 * Event envelope and the transaction slice of the catalog (docs/adr/ADR-003-events.md).
 * The log is append-only; `sequence` is server-assigned and is THE global order.
 * Remaining catalog types (buckets, goals, detectors) arrive with their subsystems.
 */
import type { MinorUnits } from "./money";
import type { AccountContinuity, OverlapReview } from "./projection/continuity";

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

/**
 * How much the CATEGORY can be trusted. Aggregators guess categories, and
 * they tell us how confident they are — a fact the doctrine requires us to
 * keep rather than launder into false certainty (docs/SystemInvariants.md:
 * uncertainty is shown, never hidden). Absent = unknown, treated as low.
 */
export type CategoryConfidence = "very_high" | "high" | "medium" | "low" | "unknown";

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
  /** The bank's raw description, e.g. "Uber 063015 SF**POOL**". */
  merchantRaw: string;
  /** The aggregator's cleaned merchant name, e.g. "Uber". Display prefers
   * this; `merchantRaw` remains the source fact. */
  merchantName?: string;
  /** Merchant logo URL from the aggregator (display only). */
  merchantLogoUrl?: string;
  category?: string;
  /** Finer-grained category, e.g. TRANSPORTATION_TAXIS_AND_RIDE_SHARES. */
  categoryDetailed?: string;
  categoryConfidence?: CategoryConfidence;
  categorySource: CategorySource;
  /** How the money moved: online, in store, ACH… (aggregator vocabulary). */
  paymentChannel?: string;
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
  | TransactionAnnotated
  | EventEnvelope<"AccountContinuitySet", Omit<AccountContinuity, "lastSequence">>
  | EventEnvelope<"TransactionOverlapReviewed", Omit<OverlapReview, "lastSequence">>
  | EventEnvelope<"BankSyncCompleted", { itemId: string; completedAt: string }>;
