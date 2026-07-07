import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  completenessScore,
  freshnessScore,
  HIGH_STAKES_CONFIDENCE_THRESHOLD,
  PURCHASE_FRESHNESS_WINDOW_SECONDS,
  reconciliationScore,
  verifyHighStakes,
} from "../src/verification/confidence.js";

describe("verification scoring (docs/verificationEngine.md)", () => {
  it("PROPERTY: all scores stay in [0,1]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        (age, window, drift, balance) => {
          for (const s of [
            freshnessScore(age, window),
            reconciliationScore(drift, balance),
          ]) {
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThanOrEqual(1);
          }
        },
      ),
    );
  });

  it("PROPERTY: freshness is monotonically non-increasing in age", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (age, extra, window) => {
          expect(freshnessScore(age + extra, window)).toBeLessThanOrEqual(
            freshnessScore(age, window),
          );
        },
      ),
    );
  });

  it("freshness: 1 inside the window, 0 at 4x, linear between", () => {
    const w = PURCHASE_FRESHNESS_WINDOW_SECONDS;
    expect(freshnessScore(w, w)).toBe(1);
    expect(freshnessScore(4 * w, w)).toBe(0);
    expect(freshnessScore(2.5 * w, w)).toBeCloseTo(0.5);
  });

  it("reconciliation: tolerance is max($5, 1%), minor drift half-scores", () => {
    expect(reconciliationScore(400, 10_000)).toBe(1); // $4 drift, $5 floor
    expect(reconciliationScore(900, 100_000)).toBe(1); // $9 drift within 1% of $1,000
    expect(reconciliationScore(2_000, 10_000)).toBe(0.5); // $20 minor drift
    expect(reconciliationScore(5_000, 10_000)).toBe(0); // $50: fail
  });

  it("completeness counts only present, non-null inputs", () => {
    expect(completenessScore(["a", "b"], { a: 1, b: null })).toBe(0.5);
    expect(completenessScore([], {})).toBe(1);
  });

  it("verifyHighStakes: fresh + complete + reconciled → VERIFIED", () => {
    const r = verifyHighStakes({
      dataAgeSeconds: 3_600,
      requiredInputs: ["availableCashMinor"],
      snapshot: { availableCashMinor: 500_000 },
      driftMinor: 0,
      reportedBalanceMinor: 500_000,
    });
    expect(r.status).toBe("VERIFIED");
    expect(r.confidence).toBeGreaterThanOrEqual(HIGH_STAKES_CONFIDENCE_THRESHOLD);
  });

  it("verifyHighStakes: stale data → CANT_VERIFY, bounded by freshness", () => {
    const r = verifyHighStakes({
      dataAgeSeconds: PURCHASE_FRESHNESS_WINDOW_SECONDS * 3.9,
      requiredInputs: ["availableCashMinor"],
      snapshot: { availableCashMinor: 500_000 },
      driftMinor: 0,
      reportedBalanceMinor: 500_000,
    });
    expect(r.status).toBe("CANT_VERIFY");
    expect(r.boundedBy).toBe("freshness");
    expect(r.reason).toContain("freshness");
  });

  it("verifyHighStakes: missing input → NEEDS_USER_INPUT naming the field", () => {
    const r = verifyHighStakes({
      dataAgeSeconds: 0,
      requiredInputs: ["availableCashMinor", "upcomingObligationsMinor"],
      snapshot: { availableCashMinor: 500_000 },
      driftMinor: 0,
      reportedBalanceMinor: 500_000,
    });
    expect(r.status).toBe("NEEDS_USER_INPUT");
    expect(r.missingInputs).toEqual(["upcomingObligationsMinor"]);
  });
});
