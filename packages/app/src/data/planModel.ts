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
  buildSnapshot,
  formatMinor,
  type Bill,
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
  totalAllocatedFormatted: string;
  upcoming30dFormatted: string;
}

export function buildPlanViewModel(input: {
  /** Cached folded state (projectionCache); `events` is the test path. */
  snapshot?: ProjectionSnapshot;
  events?: readonly EventEnvelope[];
  todayLocal: string;
}): PlanViewModel {
  const snap = input.snapshot ?? buildSnapshot(input.events ?? []);
  const { buckets, bills } = snap;

  return {
    buckets: buckets.map(bucketRow),
    bills: bills
      .slice()
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
      .map((b) => billRow(b, input.todayLocal)),
    totalAllocatedFormatted: formatMinor(
      buckets.reduce((sum, b) => sum + b.allocatedMinor, 0),
    ),
    upcoming30dFormatted: formatMinor(sumDueWithin(bills, input.todayLocal, 30)),
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

function sumDueWithin(bills: readonly Bill[], todayLocal: string, horizonDays: number): number {
  const horizon = addDays(todayLocal, horizonDays);
  return bills
    .filter((b) => b.nextDue >= todayLocal && b.nextDue <= horizon)
    .reduce((sum, b) => sum + b.expectedAmountMinor, 0);
}

/** Whole calendar days from `from` to `to` (UTC-noon to dodge DST edges). */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
