/**
 * The two architecture walkthrough traces, executable.
 * These mirror the acceptance criteria in docs/V1Scope.md: every arrow in the
 * pipeline names a component, a data shape, and a failure fallback.
 */
import { describe, expect, it } from "vitest";
import {
  applyEvents,
  buildRecommendationRecord,
  computeFinancialState,
  computeLedgerBalanceMinor,
  decidePurchase,
  emptyProjection,
  PURCHASE_REQUIRED_INPUTS,
  verifyHighStakes,
  type Account,
} from "../src/index";
import { envelope, posted } from "./helpers";

const checking: Account = {
  accountId: "acc-1",
  type: "checking",
  source: "manual", // ledger-computed so fold changes propagate directly
  name: "Everyday Checking",
  currency: "USD",
  balanceCurrentMinor: 0,
  balanceAsOf: "2026-07-07T08:00:00.000Z",
  status: "active",
  openingBalanceMinor: 500_000, // $5,000.00
};

describe("trace 1: “Can I afford this $600 purchase?”", () => {
  const projection = applyEvents(emptyProjection(), [
    posted("txn-rent", -120_000, 1, { category: "Housing" }),
    posted("txn-salary", 240_000, 2, { category: "Income" }),
  ]);

  const state = computeFinancialState({
    accounts: [checking],
    projection,
    buckets: [{ bucketId: "b-1", name: "Emergency Fund", allocatedMinor: 100_000 }],
    bills: [
      { billId: "bill-1", name: "Electricity", expectedAmountMinor: 7_430, nextDue: "2026-07-15" },
      { billId: "bill-2", name: "Car insurance", expectedAmountMinor: 12_000, nextDue: "2026-09-01" }, // outside 30d
    ],
    todayLocal: "2026-07-07",
  });

  it("state engine: available cash = ledger − buckets; obligations respect the horizon", () => {
    // $5,000 opening − $1,200 rent + $2,400 salary − $1,000 bucket = $5,200
    expect(state.availableCashMinor).toBe(520_000);
    expect(state.upcomingObligationsMinor).toBe(7_430); // only the bill inside 30 days
  });

  it("happy path: decide → verify → audit record, reconstructable by retrieval", () => {
    const decision = decidePurchase(state, { amountMinor: 60_000, description: "flight" });
    expect(decision.decision).toBe("approve"); // $5,200 − $74.30 − $600 ≫ $500 floor

    const verification = verifyHighStakes({
      dataAgeSeconds: 2 * 3600,
      requiredInputs: PURCHASE_REQUIRED_INPUTS,
      snapshot: state as unknown as Record<string, unknown>,
      driftMinor: 0,
      reportedBalanceMinor: computeLedgerBalanceMinor(checking, projection),
    });
    expect(verification.status).toBe("VERIFIED");

    const record = buildRecommendationRecord({
      recommendationId: "rec-1",
      userId: "user-1",
      createdAt: "2026-07-07T10:00:00.000Z",
      decision,
      verification,
      llm: {
        provider: "openai",
        model: "test-model",
        promptTemplateVersion: "tmpl-v1",
        explanationTextVerbatim:
          "You can afford this. After the purchase and this month's bills, $4,525.70 stays available.",
      },
    });

    // Reconstructable = retrieval: the record carries everything, verbatim.
    expect(record.decision.inputsSnapshot.availableCashMinor).toBe(520_000);
    expect(record.decision.rulesVersion).toBeTruthy();
    expect(record.decision.paramsVersion).toBeTruthy();
    expect(record.verification.confidence).toBe(1);
    expect(record.llm?.explanationTextVerbatim).toContain("You can afford this.");
  });

  it("failure fallback: stale data cannot silently approve — CANT_VERIFY with data age", () => {
    const verification = verifyHighStakes({
      dataAgeSeconds: 40 * 3600, // ~40h old, refresh-race timed out upstream
      requiredInputs: PURCHASE_REQUIRED_INPUTS,
      snapshot: state as unknown as Record<string, unknown>,
      driftMinor: 0,
      reportedBalanceMinor: 520_000,
    });
    expect(verification.status).toBe("CANT_VERIFY");
    expect(verification.dataAgeSeconds).toBe(40 * 3600);
  });

  it("failure fallback: unresolved drift blocks verification (repair path's trigger)", () => {
    const verification = verifyHighStakes({
      dataAgeSeconds: 0,
      requiredInputs: PURCHASE_REQUIRED_INPUTS,
      snapshot: state as unknown as Record<string, unknown>,
      driftMinor: 9_900, // $99 unexplained
      reportedBalanceMinor: 520_000,
    });
    expect(verification.status).toBe("CANT_VERIFY");
    expect(verification.boundedBy).toBe("reconciliation");
  });
});

describe("trace 2: Plaid removes a pending hotel hold", () => {
  it("hold released → TransactionRemoved → available cash restored, log intact", () => {
    const withHold = applyEvents(emptyProjection(), [
      posted("txn-hold", -15_000, 1, { status: "pending", merchantRaw: "HOTEL AUTH" }),
    ]);
    const stateWithHold = computeFinancialState({
      accounts: [checking],
      projection: withHold,
      buckets: [],
      bills: [],
      todayLocal: "2026-07-07",
    });
    expect(stateWithHold.availableCashMinor).toBe(485_000); // $5,000 − $150 hold

    const afterRelease = applyEvents(withHold, [
      envelope("TransactionRemoved", { txnId: "txn-hold", reason: "hold released" }, 2),
    ] as Parameters<typeof applyEvents>[1]);
    const stateAfter = computeFinancialState({
      accounts: [checking],
      projection: afterRelease,
      buckets: [],
      bills: [],
      todayLocal: "2026-07-07",
    });

    expect(stateAfter.availableCashMinor).toBe(500_000); // fully restored
    expect(afterRelease.transactions.get("txn-hold")?.removed).toBe(true); // tombstone, not delete
    expect(stateAfter.lastSequence).toBe(2); // state knows which event it reflects
  });
});
