import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decidePurchase } from "../src/decision/purchaseApproval";
import { renderTemplateExplanation } from "../src/explanation/template";
import { foldBills, foldBuckets } from "../src/projection/plans";
import type { VerificationResult } from "../src/verification/confidence";
import { envelope } from "./helpers";

const VERIFIED: VerificationResult = {
  status: "VERIFIED",
  confidence: 1,
  boundedBy: "freshness",
  dataAgeSeconds: 0,
  missingInputs: [],
};

describe("template explanation (docs/AIArchitecture.md substitution rule)", () => {
  it("PROPERTY: every dollar figure in the text comes from the decision payload — even when the user-typed description contains money strings", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 2_000_000 }),
        fc.option(
          fc.oneof(fc.string(), fc.constant("$999.99 designer shoes"), fc.constant("tickets, 250 dollars each")),
          { nil: undefined },
        ),
        (cash, obligations, amount, description) => {
          const decision = decidePurchase(
            { availableCashMinor: cash, upcomingObligationsMinor: obligations },
            { amountMinor: amount, ...(description !== undefined ? { description } : {}) },
          );
          const text = renderTemplateExplanation(decision, VERIFIED);
          const s = decision.inputsSnapshot;
          const legal = new Set(
            [
              s.amountMinor,
              s.bufferFloorMinor,
              s.upcomingObligationsMinor,
              s.availableCashMinor,
              s.availableCashMinor - s.upcomingObligationsMinor - s.amountMinor,
              -(s.availableCashMinor - s.upcomingObligationsMinor - s.amountMinor),
            ].map((m) => {
              const abs = Math.abs(m);
              return `${Math.trunc(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
            }),
          );
          for (const match of text.matchAll(/\$([\d,]+\.\d{2})/g)) {
            expect(legal).toContain(match[1]);
          }
        },
      ),
    );
  });

  it("mentions the product when a description is given", () => {
    const decision = decidePurchase(
      { availableCashMinor: 500_000, upcomingObligationsMinor: 0 },
      { amountMinor: 60_000, description: "espresso machine" },
    );
    const text = renderTemplateExplanation(decision, VERIFIED);
    expect(text).toContain("the espresso machine ($600.00)");
    expect(decision.inputsSnapshot.description).toBe("espresso machine"); // audit keeps it
  });

  it("strips money figures from user-typed descriptions (injection guard)", () => {
    const decision = decidePurchase(
      { availableCashMinor: 500_000, upcomingObligationsMinor: 0 },
      { amountMinor: 60_000, description: "$999.99 designer shoes" },
    );
    const text = renderTemplateExplanation(decision, VERIFIED);
    expect(text).not.toContain("999.99");
    expect(text).toContain("the designer shoes ($600.00)");
    // The RAW description is preserved in the audit snapshot — sanitizing is
    // a rendering rule, not a data rule.
    expect(decision.inputsSnapshot.description).toBe("$999.99 designer shoes");
  });

  it("approve / caution / decline each produce a decision-consistent sentence", () => {
    const approve = decidePurchase(
      { availableCashMinor: 500_000, upcomingObligationsMinor: 0 },
      { amountMinor: 10_000 },
    );
    expect(renderTemplateExplanation(approve, VERIFIED)).toMatch(/^Yes — you can afford \$100\.00/);

    const caution = decidePurchase(
      { availableCashMinor: 100_000, upcomingObligationsMinor: 0 },
      { amountMinor: 60_000 },
    );
    expect(renderTemplateExplanation(caution, VERIFIED)).toContain("cuts your cushion to $400.00");

    const decline = decidePurchase(
      { availableCashMinor: 50_000, upcomingObligationsMinor: 30_000 },
      { amountMinor: 60_000 },
    );
    expect(renderTemplateExplanation(decline, VERIFIED)).toContain("$400.00 short");
  });

  it("CANT_VERIFY explanation communicates uncertainty, never fabricates certainty", () => {
    const decision = decidePurchase(
      { availableCashMinor: 500_000, upcomingObligationsMinor: 0 },
      { amountMinor: 10_000 },
    );
    const text = renderTemplateExplanation(decision, {
      status: "CANT_VERIFY",
      confidence: 0.4,
      boundedBy: "freshness",
      dataAgeSeconds: 40 * 3600,
      missingInputs: [],
      reason: "stale sync",
    });
    expect(text).toContain("can't verify");
    expect(text).toContain("40h ago");
    expect(text).not.toMatch(/^Yes/);
  });
});

describe("bucket and bill folds", () => {
  it("last write by sequence wins per id", () => {
    const events = [
      envelope("BucketUpserted" as never, { bucketId: "b1", name: "Emergency", allocatedMinor: 100_000 }, 1, "user"),
      envelope("BillUpserted" as never, { billId: "x1", name: "Rent", expectedAmountMinor: 120_000, nextDue: "2026-08-01" }, 2, "user"),
      envelope("BucketUpserted" as never, { bucketId: "b1", name: "Emergency Fund", allocatedMinor: 150_000 }, 3, "user"),
    ] as never[];
    expect(foldBuckets(events)).toEqual([
      { bucketId: "b1", name: "Emergency Fund", allocatedMinor: 150_000 },
    ]);
    expect(foldBills(events)).toEqual([
      { billId: "x1", name: "Rent", expectedAmountMinor: 120_000, nextDue: "2026-08-01" },
    ]);
  });
});
