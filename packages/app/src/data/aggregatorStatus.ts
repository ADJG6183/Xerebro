/**
 * Aggregator failure as the UI understands it (mirrors the server's
 * classification in plaid/errors.ts — docs/Reliability.md).
 *
 * The rule this encodes: a sync failure is never a silent no-op and never a
 * raw stack trace. It is a sentence the user can act on, plus a flag for the
 * one case only they can fix (re-authenticating with their bank).
 */
export type AggregatorFailureKind =
  | "reauth_required"
  | "institution_down"
  | "rate_limited"
  | "config"
  | "transient"
  | "permanent";

export interface AggregatorFailure {
  kind: AggregatorFailureKind;
  userMessage: string;
  retryable: boolean;
  needsUserAction: boolean;
  code?: string;
}

/** Parse a failure out of an error thrown by the transport, if it carries one. */
export function failureOf(error: unknown): AggregatorFailure | null {
  const carried = (error as { failure?: AggregatorFailure } | null)?.failure;
  return carried && typeof carried.userMessage === "string" ? carried : null;
}
