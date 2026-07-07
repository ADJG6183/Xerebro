/**
 * Verification scoring — the PURE half of docs/verificationEngine.md.
 * Confidence is a data-quality score, not a model probability.
 *
 * The refresh-race (live aggregator pull, 3s timeout) is I/O and lives in the
 * app orchestration layer; engines are forbidden network access, so this
 * module only scores what orchestration hands it.
 */
import type { MinorUnits } from "../money";
import { assertMinorUnits } from "../money";

export const HIGH_STAKES_CONFIDENCE_THRESHOLD = 0.8;
export const PURCHASE_FRESHNESS_WINDOW_SECONDS = 12 * 60 * 60; // 12h (docs/verificationEngine.md)

/** 1.0 within the window, linear decay to 0 at 4× the window. */
export function freshnessScore(ageSeconds: number, windowSeconds: number): number {
  if (ageSeconds < 0 || windowSeconds <= 0) return 0;
  if (ageSeconds <= windowSeconds) return 1;
  const decayEnd = windowSeconds * 4;
  if (ageSeconds >= decayEnd) return 0;
  return (decayEnd - ageSeconds) / (decayEnd - windowSeconds);
}

/** Fraction of the rule family's declared inputs that are present and non-null. */
export function completenessScore(
  requiredInputs: readonly string[],
  snapshot: Record<string, unknown>,
): number {
  if (requiredInputs.length === 0) return 1;
  const present = requiredInputs.filter((k) => snapshot[k] !== undefined && snapshot[k] !== null);
  return present.length / requiredInputs.length;
}

/** Tolerance band: max($5, 1%) reconciled; ≤$25 minor drift; beyond fails. */
export function reconciliationScore(
  driftMinor: MinorUnits,
  reportedBalanceMinor: MinorUnits,
): number {
  assertMinorUnits(driftMinor, "drift");
  const tolerance = Math.max(500, Math.round(Math.abs(reportedBalanceMinor) * 0.01));
  const drift = Math.abs(driftMinor);
  if (drift <= tolerance) return 1;
  if (drift <= 2500) return 0.5;
  return 0;
}

export type VerificationStatus = "VERIFIED" | "CANT_VERIFY" | "NEEDS_USER_INPUT";

export interface VerificationResult {
  status: VerificationStatus;
  confidence: number;
  /** Which component bounded the score — stored on the audit record. */
  boundedBy: "freshness" | "completeness" | "reconciliation";
  dataAgeSeconds: number;
  missingInputs: string[];
  reason?: string;
}

export function verifyHighStakes(input: {
  dataAgeSeconds: number;
  windowSeconds?: number;
  requiredInputs: readonly string[];
  snapshot: Record<string, unknown>;
  driftMinor: MinorUnits;
  reportedBalanceMinor: MinorUnits;
}): VerificationResult {
  const windowSeconds = input.windowSeconds ?? PURCHASE_FRESHNESS_WINDOW_SECONDS;

  const scores = {
    freshness: freshnessScore(input.dataAgeSeconds, windowSeconds),
    completeness: completenessScore(input.requiredInputs, input.snapshot),
    reconciliation: reconciliationScore(input.driftMinor, input.reportedBalanceMinor),
  } as const;

  let boundedBy: VerificationResult["boundedBy"] = "freshness";
  for (const key of ["completeness", "reconciliation"] as const) {
    if (scores[key] < scores[boundedBy]) boundedBy = key;
  }
  const confidence = scores[boundedBy];

  const missingInputs = input.requiredInputs.filter(
    (k) => input.snapshot[k] === undefined || input.snapshot[k] === null,
  );

  if (missingInputs.length > 0) {
    return {
      status: "NEEDS_USER_INPUT",
      confidence,
      boundedBy: "completeness",
      dataAgeSeconds: input.dataAgeSeconds,
      missingInputs,
      reason: `Missing required inputs: ${missingInputs.join(", ")}`,
    };
  }

  if (confidence < HIGH_STAKES_CONFIDENCE_THRESHOLD) {
    return {
      status: "CANT_VERIFY",
      confidence,
      boundedBy,
      dataAgeSeconds: input.dataAgeSeconds,
      missingInputs: [],
      reason: `Confidence ${confidence.toFixed(2)} below ${HIGH_STAKES_CONFIDENCE_THRESHOLD} (bounded by ${boundedBy})`,
    };
  }

  return {
    status: "VERIFIED",
    confidence,
    boundedBy,
    dataAgeSeconds: input.dataAgeSeconds,
    missingInputs: [],
  };
}
