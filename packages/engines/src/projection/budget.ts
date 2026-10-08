/**
 * Monthly category budget limits (rocketMoneyTracker.md stage 1 #1) — upsert
 * events + fold, same convention as buckets/bills (projection/plans.ts): one
 * event type, last write by server sequence wins per id.
 *
 * Deliberately separate from Bucket (reserved savings): a BudgetPlan is a
 * comparison target for reporting, never a cash reservation. It is NOT
 * read by computeFinancialState (state/financialState.ts) and must never
 * become an input there — that's the whole point of keeping budgets from
 * double-subtracting cash. See queries/budget.ts for the read side.
 *
 * One plan per (categoryId, month): callers derive budgetPlanId
 * deterministically as `${categoryId}:${month}` (app/src/data/userEvents.ts)
 * so editing the same month's limit upserts, and a new month naturally gets
 * a new id — no special "preserve prior months" logic needed here, that
 * falls out of upsert-by-id for free.
 */
import type { EventEnvelope } from "../events";
import type { MinorUnits } from "../money";
import { validateEventPayload } from "../validation";

export interface BudgetPlan {
  budgetPlanId: string;
  categoryId: string;
  /** Local YYYY-MM. */
  month: string;
  limitMinor: MinorUnits;
  /** v1 is USD-only (DataModel.md convention) — same as Bucket/Bill, no
   * currency field until multi-currency planning is actually built. */
  enabled: boolean;
}

export type BudgetPlanUpserted = EventEnvelope<"BudgetPlanUpserted", BudgetPlan>;

export function foldBudgetPlans(events: readonly EventEnvelope[]): BudgetPlan[] {
  const byId = new Map<string, BudgetPlan>();
  for (const event of events) {
    if (event.type !== "BudgetPlanUpserted") continue;
    if (validateEventPayload(event.type, event.payload).length > 0) continue;
    const plan = event.payload as BudgetPlan;
    byId.set(plan.budgetPlanId, { ...plan });
  }
  return [...byId.values()];
}
