/**
 * Semantic classification of aggregator failures (docs/Reliability.md:
 * "Error Classification").
 *
 * Plaid returns dozens of error codes; the app doesn't care about the code,
 * it cares about ONE question: what should the user do now? Four answers:
 *
 *   reauth_required  → the user must re-login to their bank (only they can fix it)
 *   institution_down → the bank is having problems (wait; nobody's at fault)
 *   rate_limited     → we asked too often (wait; OUR fault, invisible to the user)
 *   config           → our credentials/setup are wrong (only WE can fix it)
 *   transient        → unknown but retryable
 *   permanent        → unknown and not retryable
 *
 * The classification travels to the client so the UI can say something true
 * and actionable, rather than "sync failed". Codes we don't recognize
 * degrade to transient/permanent by HTTP status — never to a crash.
 */
import { PlaidApiError } from "./httpGateway";

export type AggregatorFailureKind =
  | "reauth_required"
  | "institution_down"
  | "rate_limited"
  | "config"
  | "transient"
  | "permanent";

export interface AggregatorFailure {
  kind: AggregatorFailureKind;
  /** Safe to show a user: no ids, no tokens, no vendor jargon. */
  userMessage: string;
  /** True when retrying later could plausibly succeed. */
  retryable: boolean;
  /** True when only the user can resolve it (re-authentication). */
  needsUserAction: boolean;
  /** Vendor code, kept for logs and support — never rendered. */
  code?: string;
}

/** Plaid error codes we handle explicitly. */
const REAUTH = new Set([
  "ITEM_LOGIN_REQUIRED",
  "ITEM_LOCKED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "USER_PERMISSION_REVOKED",
  "USER_INPUT_TIMEOUT",
]);

const INSTITUTION_DOWN = new Set([
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NO_LONGER_SUPPORTED",
  "INSTITUTION_NOT_AVAILABLE",
  "INSTITUTION_REGISTRATION_REQUIRED",
]);

const CONFIG = new Set([
  "INVALID_API_KEYS",
  "INVALID_ACCESS_TOKEN",
  "INVALID_PRODUCT",
  "PRODUCTS_NOT_SUPPORTED",
  "MISSING_FIELDS",
  "UNAUTHORIZED_ENVIRONMENT",
  "INVALID_FIELD",
  "ITEM_NOT_FOUND",
]);

const TRANSIENT = new Set([
  "INTERNAL_SERVER_ERROR",
  "PLANNED_MAINTENANCE",
  "PRODUCT_NOT_READY",
  "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
]);

export function classifyAggregatorError(error: unknown): AggregatorFailure {
  const code = error instanceof PlaidApiError ? error.plaidErrorCode : undefined;
  const status = error instanceof PlaidApiError ? error.status : undefined;

  if (code && REAUTH.has(code)) {
    return {
      kind: "reauth_required",
      userMessage: "Your bank needs you to sign in again to keep syncing.",
      retryable: false,
      needsUserAction: true,
      code,
    };
  }
  if (code && INSTITUTION_DOWN.has(code)) {
    return {
      kind: "institution_down",
      userMessage: "Your bank isn't responding right now. We'll keep trying.",
      retryable: true,
      needsUserAction: false,
      code,
    };
  }
  if (code === "RATE_LIMIT" || code?.includes("RATE_LIMIT") || status === 429) {
    return {
      kind: "rate_limited",
      userMessage: "Too many updates at once — we'll refresh again shortly.",
      retryable: true,
      needsUserAction: false,
      ...(code ? { code } : {}),
    };
  }
  if (code && CONFIG.has(code)) {
    // Our problem, not the user's: say so without exposing internals.
    return {
      kind: "config",
      userMessage: "Bank syncing is misconfigured on our side. We're on it.",
      retryable: false,
      needsUserAction: false,
      code,
    };
  }
  if (code && TRANSIENT.has(code)) {
    return {
      kind: "transient",
      userMessage: "Your bank data isn't ready yet. We'll try again in a moment.",
      retryable: true,
      needsUserAction: false,
      code,
    };
  }

  // Unrecognized: fall back to the HTTP status. Network errors (no status)
  // are transient — a dropped connection deserves a retry, not a dead end.
  const retryable = status === undefined || status === 429 || status >= 500;
  return {
    kind: retryable ? "transient" : "permanent",
    userMessage: retryable
      ? "We couldn't reach your bank just now. We'll try again."
      : "We couldn't sync this account. Try reconnecting it.",
    retryable,
    needsUserAction: !retryable,
    ...(code ? { code } : {}),
  };
}
