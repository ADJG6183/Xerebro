import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decidePurchase } from "../src/decision/purchaseApproval";
import { checkFaithfulness } from "../src/explanation/faithfulness";
import { renderTemplateExplanation } from "../src/explanation/template";
import type { VerificationResult } from "../src/verification/confidence";

const VERIFIED: VerificationResult = {
  status: "VERIFIED",
  confidence: 1,
  boundedBy: "freshness",
  dataAgeSeconds: 0,
  missingInputs: [],
};

const approve = decidePurchase(
  { availableCashMinor: 520_000, upcomingObligationsMinor: 7_430 },
  { amountMinor: 60_000 },
);

describe("faithfulness checker (the leash, mechanical)", () => {
  it("PROPERTY: our own templates are always faithful", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 2_000_000 }),
        (cash, obligations, amount) => {
          const decision = decidePurchase(
            { availableCashMinor: cash, upcomingObligationsMinor: obligations },
            { amountMinor: amount },
          );
          const text = renderTemplateExplanation(decision, VERIFIED);
          expect(checkFaithfulness(text, decision).faithful).toBe(true);
        },
      ),
    );
  });

  it("accepts legal figures, whole-dollar roundings included", () => {
    const ok = checkFaithfulness(
      "Yes — the $600.00 purchase leaves $4,525.70 available; your buffer is $500.",
      approve,
    );
    expect(ok.faithful).toBe(true);
  });

  it("rejects invented money figures", () => {
    const bad = checkFaithfulness(
      "Yes — you can afford $600.00; similar espresso machines cost $349.99 elsewhere.",
      approve,
    );
    expect(bad.faithful).toBe(false);
    expect(bad.violations[0]).toContain("$349.99");
  });

  it("rejects text contradicting the verdict", () => {
    const decline = decidePurchase(
      { availableCashMinor: 50_000, upcomingObligationsMinor: 30_000 },
      { amountMinor: 60_000 },
    );
    const bad = checkFaithfulness("Yes, you can afford this comfortably.", decline);
    expect(bad.faithful).toBe(false);
    expect(bad.violations.some((v) => v.includes("contradicts verdict"))).toBe(true);
  });
});
