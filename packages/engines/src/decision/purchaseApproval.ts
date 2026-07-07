/**
 * Purchase-approval rule family — the one Decision Engine family v1 ships
 * (docs/decisionEngine.md, docs/V1Scope.md).
 *
 * Determinism contract: same inputsSnapshot + rulesVersion + paramsVersion
 * → byte-identical output, forever. Pure function; no clocks, no randomness,
 * no network. Property-tested in test/decision.test.ts.
 */
import type { MinorUnits } from "../money";
import { assertMinorUnits, formatMinor } from "../money";
import type { FinancialStateSnapshot } from "../state/financialState";

export const RULES_VERSION = "rules-v0.1.0";

/** Bounded learned parameters (Lane 2 changes these via user approval only). */
export interface PurchaseParams {
  paramsVersion: string;
  /** Cash that must remain untouched after the purchase and obligations. */
  bufferFloorMinor: MinorUnits;
}

export const DEFAULT_PURCHASE_PARAMS: PurchaseParams = {
  paramsVersion: "params-v0.1.0",
  bufferFloorMinor: 50_000, // $500.00
};

/** Inputs the rules read — verification scores completeness against this list. */
export const PURCHASE_REQUIRED_INPUTS = [
  "availableCashMinor",
  "upcomingObligationsMinor",
] as const;

export interface PurchaseQuestion {
  amountMinor: MinorUnits;
  description?: string;
}

export interface Tradeoff {
  code: string;
  detail: string;
  amountMinor?: MinorUnits;
}

export interface PurchaseDecision {
  decisionClass: "high_stakes";
  decision: "approve" | "caution" | "decline";
  /** 0 = no risk, 100 = certain shortfall. Deterministic function of inputs. */
  riskScore: number;
  tradeoffs: Tradeoff[];
  requiredConditions: string[];
  rulesFired: string[];
  inputsSnapshot: {
    amountMinor: MinorUnits;
    availableCashMinor: MinorUnits;
    upcomingObligationsMinor: MinorUnits;
    bufferFloorMinor: MinorUnits;
  };
  rulesVersion: string;
  paramsVersion: string;
}

export function decidePurchase(
  state: Pick<FinancialStateSnapshot, "availableCashMinor" | "upcomingObligationsMinor">,
  question: PurchaseQuestion,
  params: PurchaseParams = DEFAULT_PURCHASE_PARAMS,
): PurchaseDecision {
  const amount = assertMinorUnits(question.amountMinor, "purchase amount");
  if (amount <= 0) throw new RangeError("purchase amount must be positive minor units");

  const { availableCashMinor, upcomingObligationsMinor } = state;
  const { bufferFloorMinor } = params;
  const remaining = availableCashMinor - upcomingObligationsMinor - amount;

  const rulesFired: string[] = [];
  const tradeoffs: Tradeoff[] = [];
  const requiredConditions: string[] = [];

  let decision: PurchaseDecision["decision"];
  if (remaining < 0) {
    decision = "decline";
    rulesFired.push("purchase.shortfall");
    tradeoffs.push({
      code: "shortfall",
      detail: `This purchase leaves you ${formatMinor(-remaining)} short of covering the next 30 days of obligations.`,
      amountMinor: -remaining,
    });
  } else if (remaining < bufferFloorMinor) {
    decision = "caution";
    rulesFired.push("purchase.buffer-breach");
    tradeoffs.push({
      code: "buffer-breach",
      detail: `You can cover it, but your cash buffer drops to ${formatMinor(remaining)}, below your ${formatMinor(bufferFloorMinor)} floor.`,
      amountMinor: remaining,
    });
    requiredConditions.push("Accept a cash buffer below your configured floor until the next paycheck.");
  } else {
    decision = "approve";
    rulesFired.push("purchase.within-buffer");
    tradeoffs.push({
      code: "buffer-after",
      detail: `After this purchase and 30 days of obligations, ${formatMinor(remaining)} remains available.`,
      amountMinor: remaining,
    });
  }

  // Risk rises as `remaining` falls from 2× buffer (0) to −amount (100). Integer output.
  const span = bufferFloorMinor * 2 + amount;
  const riskScore = clampInt(Math.round(((bufferFloorMinor * 2 - remaining) / span) * 100), 0, 100);

  return {
    decisionClass: "high_stakes",
    decision,
    riskScore,
    tradeoffs,
    requiredConditions,
    rulesFired,
    inputsSnapshot: {
      amountMinor: amount,
      availableCashMinor,
      upcomingObligationsMinor,
      bufferFloorMinor,
    },
    rulesVersion: RULES_VERSION,
    paramsVersion: params.paramsVersion,
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
