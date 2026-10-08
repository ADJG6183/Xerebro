import type { TransactionProjection, TransactionRow } from "./transactions";

export interface ContinuityCandidate {
  accountId: string;
  lastSyncedAt?: string;
}

export interface AccountContinuity {
  accountId: string;
  candidates: readonly ContinuityCandidate[];
  decision: "pending" | "same" | "different";
  predecessorId?: string;
  /** Inclusive local-date boundary: the entire handoff day needs review. */
  cutoffDate?: string;
  lastSequence: number;
}

export interface OverlapReview {
  txnId: string;
  decision: "duplicate" | "unique" | "reopen";
  originalTxnId?: string;
  signature: string;
  originalSignature?: string;
  continuitySequence: number;
  lastSequence: number;
}

export type ContinuityCommand =
  | { kind: "account"; commandId: string; accountId: string; expectedVersion: number;
      decision: "same" | "different" | "reopen"; predecessorId?: string; timeZone: string }
  | { kind: "transaction"; commandId: string; txnId: string; expectedVersion: number;
      continuityVersion: number; decision: "duplicate" | "unique" | "reopen"; originalTxnId?: string };

/** Bank facts only. An annotation does not invalidate an identity decision. */
export function transactionSignature(row: TransactionRow): string {
  return JSON.stringify([row.accountId, row.amountMinor, row.currency, row.status,
    row.postedDate ?? null, row.authorizedDate ?? null, row.merchantRaw, row.removed]);
}

export function overlapKey(row: TransactionRow): string | undefined {
  if (row.removed || row.status !== "posted" || !row.postedDate || !row.merchantRaw.trim()) return;
  return JSON.stringify([row.amountMinor, row.currency, row.postedDate,
    row.merchantRaw.trim().toLowerCase()]);
}

export function predecessorIds(projection: TransactionProjection, accountId: string): Set<string> {
  const result = new Set<string>();
  let current = projection.continuity?.get(accountId);
  while (current?.decision === "same" && current.predecessorId && !result.has(current.predecessorId)) {
    result.add(current.predecessorId);
    current = projection.continuity?.get(current.predecessorId);
  }
  return result;
}

/** Raw uncertainty, before a user review is applied. */
export function needsOverlapReview(projection: TransactionProjection, row: TransactionRow): boolean {
  const continuity = projection.continuity?.get(row.accountId);
  if (!continuity || continuity.decision === "different") return false;
  if (continuity.decision === "pending") return true;
  return !continuity.cutoffDate || !row.postedDate || row.postedDate <= continuity.cutoffDate;
}

export type HistoryExclusion = "account_review" | "overlap_review" | "confirmed_duplicate";

/** One shared policy for dashboard, copilot, and decision inputs. */
export function historyExclusions(projection: TransactionProjection): Map<string, HistoryExclusion> {
  const excluded = new Map<string, HistoryExclusion>();
  const ancestors = new Map<string, Set<string>>();
  for (const row of projection.transactions.values()) {
    if (row.removed || !needsOverlapReview(projection, row)) continue;
    const continuity = projection.continuity!.get(row.accountId)!;
    if (continuity.decision === "pending") {
      excluded.set(row.txnId, "account_review");
      continue;
    }
    const review = projection.overlapReviews?.get(row.txnId);
    const valid = review && review.continuitySequence === continuity.lastSequence &&
      review.signature === transactionSignature(row);
    if (valid && review.decision === "unique") continue;
    excluded.set(row.txnId, "overlap_review");
    if (!valid || review.decision !== "duplicate" || !review.originalTxnId) continue;
    const original = projection.transactions.get(review.originalTxnId);
    let chain = ancestors.get(row.accountId);
    if (!chain) {
      chain = predecessorIds(projection, row.accountId);
      ancestors.set(row.accountId, chain);
    }
    if (original && !original.removed && chain.has(original.accountId) &&
        review.originalSignature === transactionSignature(original) &&
        overlapKey(row) !== undefined && overlapKey(row) === overlapKey(original)) {
      excluded.set(row.txnId, "confirmed_duplicate");
    }
  }
  // Facts can change away and then back after another match was saved. Recheck
  // one-to-one on replay too; command-time validation alone is insufficient.
  const claims = new Map<string, string[]>();
  for (const [txnId, reason] of excluded) {
    if (reason !== "confirmed_duplicate") continue;
    const key = JSON.stringify([projection.transactions.get(txnId)!.accountId,
      projection.overlapReviews!.get(txnId)!.originalTxnId]);
    const bucket = claims.get(key) ?? [];
    bucket.push(txnId);
    claims.set(key, bucket);
  }
  for (const bucket of claims.values()) {
    if (bucket.length > 1) for (const txnId of bucket) excluded.set(txnId, "overlap_review");
  }
  // A retained original can itself become uncertain after a correction or
  // reopened account decision. Never hide both sides as a confirmed match.
  for (const [txnId, reason] of excluded) {
    if (reason !== "confirmed_duplicate") continue;
    const originalId = projection.overlapReviews!.get(txnId)!.originalTxnId!;
    if (excluded.has(originalId)) excluded.set(txnId, "overlap_review");
  }
  return excluded;
}

export function historyReviewIssues(projection: TransactionProjection): string[] {
  const pending = [...(projection.continuity?.values() ?? [])].some((c) => c.decision === "pending");
  const overlap = [...historyExclusions(projection).values()].some((r) => r !== "confirmed_duplicate");
  return pending || overlap
    ? ["Spending history is incomplete until reconnected accounts and overlapping transactions are reviewed in Accounts."]
    : [];
}
