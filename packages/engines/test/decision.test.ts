import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_PURCHASE_PARAMS,
  decidePurchase,
  RULES_VERSION,
} from "../src/decision/purchaseApproval";

const arbState = fc.record({
  availableCashMinor: fc.integer({ min: -1_000_000, max: 10_000_000 }),
  upcomingObligationsMinor: fc.integer({ min: 0, max: 2_000_000 }),
});
const arbAmount = fc.integer({ min: 1, max: 5_000_000 });

describe("purchase approval (decision engine determinism contract)", () => {
  it("PROPERTY: same inputs → byte-identical output, across repeated calls", () => {
    fc.assert(
      fc.property(arbState, arbAmount, (state, amountMinor) => {
        const a = decidePurchase(state, { amountMinor });
        const b = decidePurchase(state, { amountMinor });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }),
    );
  });

  it("PROPERTY: riskScore is an integer in [0,100] and rises as cash falls", () => {
    fc.assert(
      fc.property(arbState, arbAmount, fc.integer({ min: 1, max: 500_000 }), (state, amt, less) => {
        const richer = decidePurchase(state, { amountMinor: amt });
        const poorer = decidePurchase(
          { ...state, availableCashMinor: state.availableCashMinor - less },
          { amountMinor: amt },
        );
        for (const d of [richer, poorer]) {
          expect(Number.isInteger(d.riskScore)).toBe(true);
          expect(d.riskScore).toBeGreaterThanOrEqual(0);
          expect(d.riskScore).toBeLessThanOrEqual(100);
        }
        expect(poorer.riskScore).toBeGreaterThanOrEqual(richer.riskScore);
      }),
    );
  });

  it("PROPERTY: every decision carries versions and a complete inputs snapshot", () => {
    fc.assert(
      fc.property(arbState, arbAmount, (state, amountMinor) => {
        const d = decidePurchase(state, { amountMinor });
        expect(d.rulesVersion).toBe(RULES_VERSION);
        expect(d.paramsVersion).toBe(DEFAULT_PURCHASE_PARAMS.paramsVersion);
        expect(d.inputsSnapshot).toEqual({
          amountMinor,
          availableCashMinor: state.availableCashMinor,
          upcomingObligationsMinor: state.upcomingObligationsMinor,
          bufferFloorMinor: DEFAULT_PURCHASE_PARAMS.bufferFloorMinor,
        });
        expect(d.rulesFired.length).toBeGreaterThan(0);
        expect(d.tradeoffs.length).toBeGreaterThan(0);
      }),
    );
  });

  it("approves when the buffer floor survives", () => {
    const d = decidePurchase(
      { availableCashMinor: 500_000, upcomingObligationsMinor: 100_000 },
      { amountMinor: 60_000 }, // $600 leaves $3,400 — above the $500 floor
    );
    expect(d.decision).toBe("approve");
    expect(d.rulesFired).toContain("purchase.within-buffer");
  });

  it("cautions when covered but the buffer floor is breached", () => {
    const d = decidePurchase(
      { availableCashMinor: 200_000, upcomingObligationsMinor: 100_000 },
      { amountMinor: 60_000 }, // leaves $400 — below the $500 floor
    );
    expect(d.decision).toBe("caution");
    expect(d.requiredConditions.length).toBeGreaterThan(0);
  });

  it("declines on shortfall and quantifies it in the tradeoff", () => {
    const d = decidePurchase(
      { availableCashMinor: 100_000, upcomingObligationsMinor: 80_000 },
      { amountMinor: 60_000 }, // $400 short
    );
    expect(d.decision).toBe("decline");
    expect(d.tradeoffs[0]?.amountMinor).toBe(40_000);
  });

  it("rejects non-positive and float amounts", () => {
    const state = { availableCashMinor: 100_000, upcomingObligationsMinor: 0 };
    expect(() => decidePurchase(state, { amountMinor: 0 })).toThrow(RangeError);
    expect(() => decidePurchase(state, { amountMinor: 10.5 })).toThrow(TypeError);
  });
});
