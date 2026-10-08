/**
 * Budget-screen view-model (docs/uiDesign/image2.png screen 3): buckets with
 * progress toward targets, and upcoming bills with human due-date labels.
 * Pure — today's local date is injected, never read from a clock, so the
 * "due in N days" labels are deterministic and testable.
 *
 * Buckets and bills are the SAME data the decision engine reads (they feed
 * available-cash and the 30-day obligations math): this screen is a window
 * onto the numbers that decide "Can I buy this?", not a separate ledger.
 */
import {
  budgetProgress,
  buildSnapshot,
  computeUpcomingObligationsMinor,
  formatMinor,
  type Bill,
  type BudgetProgressRow,
  type Bucket,
  type EventEnvelope,
  type ProjectionSnapshot,
} from "@xerebro/engines";

export interface BucketRow {
  bucketId: string;
  name: string;
  allocatedFormatted: string;
  targetFormatted?: string;
  /** 0–100, integer; absent target → undefined (no bar). */
  progressPercent?: number;
}

export interface BudgetRow {
  budgetPlanId: string;
  categoryId: string;
  enabled: boolean;
  limitFormatted: string;
  spentFormatted: string;
  remainingFormatted: string;
  /** Negative remaining shown as an amount, not just a color (spec §6 Budget). */
  overLimit: boolean;
  /** 0–100+, integer; UI clamps the bar at 100 but reads this to decide the
   * over-limit color, same convention as BucketRow. */
  progressPercent: number;
  /** Present only when nonzero — a category with no pending charges doesn't
   * need the line at all. */
  pendingFormatted?: string;
}

export interface BillRow {
  billId: string;
  name: string;
  amountFormatted: string;
  nextDue: string;
  dueLabel: string;
  /** True when due within the next 7 days (or already past). */
  soon: boolean;
  kind: "bill" | "subscription";
}

export interface PlanViewModel {
  buckets: BucketRow[];
  bills: BillRow[];
  /** Monthly category limits (rocketMoneyTracker.md stage 1 #1) — a
   * SEPARATE section from buckets: reserved savings vs. a spending
   * comparison target. Never affects totalAllocatedFormatted below. */
  budgets: BudgetRow[];
  /** Local YYYY-MM the budgets above reflect. */
  budgetMonth: string;
  totalAllocatedFormatted: string;
  upcoming30dFormatted: string;
}

export function buildPlanViewModel(input: {
  /** Cached folded state (projectionCache); `events` is the test path. */
  snapshot?: ProjectionSnapshot;
  events?: readonly EventEnvelope[];
  todayLocal: string;
  /** Local YYYY-MM; defaults to the current month. */
  budgetMonth?: string;
}): PlanViewModel {
  const snap = input.snapshot ?? buildSnapshot(input.events ?? []);
  const { buckets, bills } = snap;
  const budgetMonth = input.budgetMonth ?? input.todayLocal.slice(0, 7);

  return {
    buckets: buckets.map(bucketRow),
    bills: bills
      .slice()
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
      .map((b) => billRow(b, input.todayLocal)),
    budgets: budgetProgress(snap.transactions, snap.budgetPlans, budgetMonth).map(budgetRow),
    budgetMonth,
    totalAllocatedFormatted: formatMinor(
      buckets.reduce((sum, b) => sum + b.allocatedMinor, 0),
    ),
    // Same function the purchase decision reads (computeFinancialState) —
    // this screen must never show a different "upcoming obligations"
    // number than what actually governed the last verdict.
    upcoming30dFormatted: formatMinor(computeUpcomingObligationsMinor(bills, input.todayLocal, 30)),
  };
}

function budgetRow(p: BudgetProgressRow): BudgetRow {
  return {
    budgetPlanId: p.budgetPlanId,
    categoryId: p.categoryId,
    enabled: p.enabled,
    limitFormatted: formatMinor(p.limitMinor),
    spentFormatted: formatMinor(p.spentMinor),
    // Over limit: show the actual remaining AMOUNT (now negative), never
    // just a color (spec §6 Budget: "overspending is shown as an amount,
    // not only color").
    remainingFormatted: formatMinor(p.remainingMinor),
    overLimit: p.overLimitMinor > 0,
    progressPercent: p.limitMinor > 0 ? Math.round((p.spentMinor / p.limitMinor) * 100) : 0,
    ...(p.pendingMinor > 0 ? { pendingFormatted: formatMinor(p.pendingMinor) } : {}),
  };
}

function bucketRow(b: Bucket): BucketRow {
  const row: BucketRow = {
    bucketId: b.bucketId,
    name: b.name,
    allocatedFormatted: formatMinor(b.allocatedMinor),
  };
  if (b.targetMinor !== undefined && b.targetMinor > 0) {
    row.targetFormatted = formatMinor(b.targetMinor);
    row.progressPercent = Math.min(100, Math.round((b.allocatedMinor / b.targetMinor) * 100));
  }
  return row;
}

function billRow(b: Bill, todayLocal: string): BillRow {
  const days = daysBetween(todayLocal, b.nextDue);
  return {
    billId: b.billId,
    name: b.name,
    amountFormatted: formatMinor(b.expectedAmountMinor),
    nextDue: b.nextDue,
    dueLabel: dueLabel(days),
    soon: days <= 7,
    kind: b.kind ?? "bill",
  };
}

function dueLabel(days: number): string {
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days} days`;
}

/** Whole calendar days from `from` to `to` (UTC-noon to dodge DST edges). */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
