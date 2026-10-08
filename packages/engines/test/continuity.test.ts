import { describe, expect, it } from "vitest";
import {
  advanceSnapshot, buildSnapshot, computeFinancialState, effectiveTransactions, emptySnapshot,
  historyExclusions, historyReviewIssues, spendTotal, transactionSignature,
  type EventEnvelope,
} from "../src";

function event(type: string, payload: unknown, sequence: number): EventEnvelope {
  return { type, payload, sequence, eventId: `e${sequence}`, idempotencyKey: `k${sequence}`,
    occurredAt: "2026-09-12T12:00:00Z", source: "system", schemaVersion: 1 };
}
const txn = (id: string, accountId: string, date = "2026-09-12", status = "posted") => ({
  txnId: id, accountId, postedDate: date, status, amountMinor: -1000, currency: "USD", merchantRaw: "COFFEE", categorySource: "plaid",
});
const continuity = { accountId: "new", candidates: [{ accountId: "old" }], decision: "same", predecessorId: "old", cutoffDate: "2026-09-12" };
const base = () => [event("TransactionPosted", txn("old-t", "old"), 1),
  event("AccountContinuitySet", continuity, 2), event("TransactionPosted", txn("new-t", "new"), 3)];
function reviewed(events: EventEnvelope[], decision: "duplicate" | "unique") {
  const p = buildSnapshot(events).transactions;
  return event("TransactionOverlapReviewed", { txnId: "new-t", decision,
    signature: transactionSignature(p.transactions.get("new-t")!), continuitySequence: 2,
    ...(decision === "duplicate" ? { originalTxnId: "old-t", originalSignature: transactionSignature(p.transactions.get("old-t")!) } : {}) }, 4);
}

describe("reconnected account history", () => {
  it("keeps pre-handoff and same-day imports visible but excludes them from shared totals", () => {
    const events = [...base(), event("TransactionPosted", txn("earlier", "new", "2026-09-11"), 4),
      event("TransactionPosted", txn("later", "new", "2026-09-13"), 5)];
    const p = buildSnapshot(events).transactions;
    expect(effectiveTransactions(p).map((t) => t.txnId)).toEqual(["old-t", "later"]);
    expect(effectiveTransactions(p, { includeExcluded: true })).toHaveLength(4);
    expect(spendTotal(events, { fromDate: "2026-09-01", toDate: "2026-09-30" })).toBe(2000);
    expect(historyReviewIssues(p)).toHaveLength(1);
  });

  it("quarantines all new history while identity or checkpoint is unknown", () => {
    for (const c of [{ ...continuity, decision: "pending" }, { ...continuity, cutoffDate: undefined }]) {
      const p = buildSnapshot([event("AccountContinuitySet", c, 1), event("TransactionPosted", txn("new-t", "new", "2027-01-01"), 2)]).transactions;
      expect(effectiveTransactions(p)).toHaveLength(0);
      expect(historyReviewIssues(p)).toHaveLength(1);
    }
  });

  it("retains pending withdrawals in the bank cash fallback while history is excluded", () => {
    const p = buildSnapshot([...base(), event("TransactionPosted", txn("pending", "new", "2026-09-12", "pending"), 4)]).transactions;
    const state = computeFinancialState({ projection: p, accounts: [{ accountId: "new", type: "checking", source: "plaid", name: "Bank", currency: "USD",
      balanceCurrentMinor: 10000, balanceAsOf: "2026-09-12T12:00:00Z", status: "active" }], buckets: [], bills: [], todayLocal: "2026-09-12" });
    expect(state.availableCashMinor).toBe(9000);
    expect(state.historyWarnings).toHaveLength(1);
  });

  it("confirms one purchase without deleting either source or its annotations", () => {
    const events = base(); events.push(reviewed(events, "duplicate"));
    events.push(event("TransactionAnnotated", { txnId: "old-t", note: "My note", renamedMerchant: "Coffee with Sam" }, 5));
    const p = buildSnapshot(events).transactions;
    expect(p.transactions.size).toBe(2);
    expect(historyExclusions(p).get("new-t")).toBe("confirmed_duplicate");
    expect(historyReviewIssues(p)).toEqual([]);
    expect(effectiveTransactions(p)[0]?.effectiveMerchant).toBe("Coffee with Sam");
  });

  it.each(["original-update", "original-remove", "new-update", "reopen"])("invalidates stale matches: %s", (change) => {
    const events = base(); events.push(reviewed(events, "duplicate"));
    events.push(change === "reopen" ? event("AccountContinuitySet", { ...continuity, decision: "pending" }, 5)
      : change === "original-remove" ? event("TransactionRemoved", { txnId: "old-t" }, 5)
      : event("TransactionUpdated", { txnId: change === "new-update" ? "new-t" : "old-t", changes: { amountMinor: -1200 } }, 5));
    const p = buildSnapshot(events).transactions;
    expect(historyExclusions(p).get("new-t")).not.toBe("confirmed_duplicate");
    expect(historyReviewIssues(p)).toHaveLength(1);
  });

  it("allows unique transactions, reopens them, and rebuilds identically at every split", () => {
    const events = base(); events.push(reviewed(events, "unique"));
    expect(effectiveTransactions(buildSnapshot(events).transactions)).toHaveLength(2);
    events.push(event("AccountContinuitySet", { ...continuity, decision: "pending" }, 5));
    for (let split = 0; split <= events.length; split++) {
      expect(advanceSnapshot(buildSnapshot(events.slice(0, split)), events.slice(split))).toEqual(buildSnapshot(events));
    }
    expect(events.reduce((s, e) => advanceSnapshot(s, [e]), emptySnapshot())).toEqual(buildSnapshot(events));
  });

  it("a bank update invalidates a unique review too", () => {
    const events = base(); events.push(reviewed(events, "unique"));
    events.push(event("TransactionUpdated", { txnId: "new-t", changes: { amountMinor: -1100 } }, 5));
    expect(historyExclusions(buildSnapshot(events).transactions).get("new-t")).toBe("overlap_review");
  });

  it("unknown/malformed review events cannot poison replay", () => {
    expect(() => buildSnapshot([event("AccountContinuitySet", { candidates: [null] }, 1)])).not.toThrow();
    expect(buildSnapshot([event("TransactionOverlapReviewed", {}, 1)]).transactions.warnings).toHaveLength(1);
  });

  it("re-quarantines competing matches when changed bank facts change back", () => {
    const events = base(); events.push(reviewed(events, "duplicate"));
    events.push(event("TransactionUpdated", { txnId: "new-t", changes: { amountMinor: -1100 } }, 5));
    events.push(event("TransactionPosted", txn("second", "new"), 6));
    const p = buildSnapshot(events).transactions;
    events.push(event("TransactionOverlapReviewed", { txnId: "second", decision: "duplicate", continuitySequence: 2,
      signature: transactionSignature(p.transactions.get("second")!), originalTxnId: "old-t",
      originalSignature: transactionSignature(p.transactions.get("old-t")!) }, 7));
    events.push(event("TransactionUpdated", { txnId: "new-t", changes: { amountMinor: -1000 } }, 8));
    const excluded = historyExclusions(buildSnapshot(events).transactions);
    expect(excluded.get("new-t")).toBe("overlap_review");
    expect(excluded.get("second")).toBe("overlap_review");
  });

  it.each([10000, 50000])("folds a %i-transaction batch without mutating the previous snapshot", (size) => {
    const initial = buildSnapshot(base());
    const events = Array.from({ length: size }, (_, i) => event("TransactionPosted", txn(`batch-${i}`, "other"), i + 4));
    const next = advanceSnapshot(initial, events);
    expect(initial.transactions.transactions.size).toBe(2);
    expect(next.transactions.transactions.size).toBe(size + 2);
  });
});
