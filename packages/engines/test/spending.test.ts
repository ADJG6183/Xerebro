/**
 * The projection-based entry points (spendTotalFromProjection,
 * spendByCategoryFromProjection) exist so a caller already holding a folded
 * TransactionProjection (the device's projectionCache, a server request's
 * per-call fold) never has to re-fold raw events just to run a report. The
 * events-based spendTotal/spendByCategory (tested via copilot.test.ts) are
 * thin wrappers over these — this file tests the projection entry point
 * directly, not through that wrapper.
 */
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../src/events";
import { buildSnapshot } from "../src/projection/snapshot";
import {
  pendingSpendTotalFromProjection,
  spendByCategoryFromProjection,
  spendTotalFromProjection,
} from "../src/queries/spending";

let seq = 0;
function txn(
  txnId: string,
  amountMinor: number,
  postedDate: string,
  category?: string,
  opts: { status?: "pending" | "posted"; authorizedDate?: string } = {},
): EventEnvelope {
  seq += 1;
  return {
    eventId: `e-${seq}`,
    sequence: seq,
    type: "TransactionPosted",
    schemaVersion: 1,
    occurredAt: "2026-07-12T10:00:00.000Z",
    source: "user",
    idempotencyKey: `k-${seq}`,
    payload: {
      txnId,
      accountId: "acc-1",
      amountMinor,
      currency: "USD",
      status: opts.status ?? "posted",
      postedDate,
      ...(opts.authorizedDate ? { authorizedDate: opts.authorizedDate } : {}),
      merchantRaw: txnId,
      ...(category ? { category } : {}),
      categorySource: "user",
    },
  } as EventEnvelope;
}

const JUNE = { fromDate: "2026-06-01", toDate: "2026-06-30" };

function projectionOf(events: readonly EventEnvelope[]) {
  return buildSnapshot(events).transactions;
}

describe("spending queries, projection entry point", () => {
  it("spendTotalFromProjection counts only outflows in range; income never counts", () => {
    seq = 0;
    const projection = projectionOf([
      txn("t-rent", -120_000, "2026-06-03", "Housing"),
      txn("t-groceries", -6_842, "2026-06-10", "Groceries"),
      txn("t-salary", 240_000, "2026-06-01", "Income"),
      txn("t-july", -9_999, "2026-07-05", "Dining"), // outside range
    ]);
    expect(spendTotalFromProjection(projection, JUNE)).toBe(120_000 + 6_842);
  });

  it("spendTotalFromProjection filters by category, case-insensitively", () => {
    seq = 0;
    const projection = projectionOf([
      txn("t-groceries-1", -6_842, "2026-06-10", "Groceries"),
      txn("t-groceries-2", -4_158, "2026-06-20", "Groceries"),
      txn("t-dining", -3_000, "2026-06-15", "Dining"),
    ]);
    expect(spendTotalFromProjection(projection, { ...JUNE, category: "groceries" })).toBe(11_000);
  });

  it("spendByCategoryFromProjection groups and sorts largest first", () => {
    seq = 0;
    const projection = projectionOf([
      txn("t-rent", -120_000, "2026-06-03", "Housing"),
      txn("t-groceries", -6_842, "2026-06-10", "Groceries"),
      txn("t-dining", -3_000, "2026-06-15", "Dining"),
    ]);
    const rows = spendByCategoryFromProjection(projection, JUNE);
    expect(rows.map((r) => r.category)).toEqual(["Housing", "Groceries", "Dining"]);
    expect(rows[0]).toEqual({ category: "Housing", totalMinor: 120_000 });
  });

  it("an already-folded projection does not get re-folded: feeding it the SAME projection twice gives the SAME totals (no double counting via repeated folding)", () => {
    seq = 0;
    const projection = projectionOf([txn("t-1", -1_000, "2026-06-01", "Dining")]);
    expect(spendTotalFromProjection(projection, JUNE)).toBe(1_000);
    expect(spendTotalFromProjection(projection, JUNE)).toBe(1_000); // calling again doesn't accumulate
  });

  it("a pending charge is NOT settled spend, even though Plaid gives it a postedDate", () => {
    seq = 0;
    const projection = projectionOf([
      txn("t-posted", -5_000, "2026-06-10", "Dining"),
      txn("t-pending", -2_000, "2026-06-12", "Dining", { status: "pending" }),
    ]);
    // Only the posted charge counts as settled spend — the pending one must
    // not be silently folded in just because it also carries a postedDate.
    expect(spendTotalFromProjection(projection, JUNE)).toBe(5_000);
  });

  it("pendingSpendTotalFromProjection reports pending spend separately, attributed by authorizedDate first", () => {
    seq = 0;
    const projection = projectionOf([
      // authorizedDate is in June; Plaid's postedDate (provisional) already
      // rolled into July — attribution must follow authorizedDate, not that.
      txn("t-pending-1", -2_000, "2026-07-01", "Dining", {
        status: "pending",
        authorizedDate: "2026-06-29",
      }),
      // No authorizedDate at all: falls back to postedDate.
      txn("t-pending-2", -1_500, "2026-06-15", "Groceries", { status: "pending" }),
      txn("t-posted", -5_000, "2026-06-10", "Dining"), // settled — must not be counted here
    ]);
    expect(pendingSpendTotalFromProjection(projection, JUNE)).toBe(2_000 + 1_500);
  });
});
