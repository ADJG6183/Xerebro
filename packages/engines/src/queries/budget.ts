/**
 * Monthly budget progress (rocketMoneyTracker.md stage 1 #1): limit vs.
 * settled spend vs. pending spend, per category, for one month. Reuses
 * spendTotalFromProjection/pendingSpendTotalFromProjection — the exact same
 * settled/pending split and case-insensitive category match the Spending
 * screen uses, so a budget's "spent" figure and Spending's own total for
 * that category never disagree.
 *
 * Reads a TransactionProjection + BudgetPlan[] — never computeFinancialState
 * — by construction a budget limit cannot feed back into available cash.
 */
import type { MinorUnits } from "../money";
import type { BudgetPlan } from "../projection/budget";
import type { TransactionProjection } from "../projection/transactions";
import { monthDateRange, pendingSpendTotalFromProjection, spendTotalFromProjection } from "./spending";

export interface BudgetProgressRow {
  budgetPlanId: string;
  categoryId: string;
  month: string;
  enabled: boolean;
  limitMinor: MinorUnits;
  /** Settled (posted-only) spend in this category/month. */
  spentMinor: MinorUnits;
  /** Committed/pending spend — shown separately, never added to spentMinor. */
  pendingMinor: MinorUnits;
  /** limitMinor - spentMinor; negative means over the limit. */
  remainingMinor: MinorUnits;
  /** max(0, spentMinor - limitMinor) — an amount, not just a boolean. */
  overLimitMinor: MinorUnits;
}

/** One row per plan whose month matches `month`, in the plans' given order. */
export function budgetProgress(
  projection: TransactionProjection,
  plans: readonly BudgetPlan[],
  month: string,
): BudgetProgressRow[] {
  const range = monthDateRange(month);
  return plans
    .filter((p) => p.month === month)
    .map((p) => {
      const spentMinor = spendTotalFromProjection(projection, { ...range, category: p.categoryId });
      const pendingMinor = pendingSpendTotalFromProjection(projection, { ...range, category: p.categoryId });
      return {
        budgetPlanId: p.budgetPlanId,
        categoryId: p.categoryId,
        month: p.month,
        enabled: p.enabled,
        limitMinor: p.limitMinor,
        spentMinor,
        pendingMinor,
        remainingMinor: p.limitMinor - spentMinor,
        overLimitMinor: Math.max(0, spentMinor - p.limitMinor),
      };
    });
}
