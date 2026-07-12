import { describe, expect, it } from "vitest";
import { buildPlanViewModel } from "../src/data/planModel";
import { billUpserted, bucketUpserted, type EventFactoryDeps } from "../src/data/userEvents";
import type { EventEnvelope } from "@xerebro/engines";

const deps: EventFactoryDeps = {
  newId: (() => {
    let n = 0;
    return () => `id-${++n}`;
  })(),
  nowIso: () => "2026-07-12T08:00:00.000Z",
  deviceId: "device-a",
};

function sequenced(events: Omit<EventEnvelope, "sequence">[]): EventEnvelope[] {
  return events.map((e, i) => ({ ...e, sequence: i + 1 }) as EventEnvelope);
}

describe("plan view-model", () => {
  it("buckets show progress toward a target; totals sum allocations", () => {
    const events = sequenced([
      bucketUpserted(deps, { bucketId: "b1", name: "Emergency", allocatedMinor: 250_000, targetMinor: 1_000_000 }),
      bucketUpserted(deps, { bucketId: "b2", name: "Vacation", allocatedMinor: 50_000 }),
    ]);
    const vm = buildPlanViewModel({ events, todayLocal: "2026-07-12" });

    expect(vm.totalAllocatedFormatted).toBe("$3,000.00");
    const emergency = vm.buckets.find((b) => b.name === "Emergency")!;
    expect(emergency.progressPercent).toBe(25);
    expect(emergency.targetFormatted).toBe("$10,000.00");
    expect(vm.buckets.find((b) => b.name === "Vacation")!.progressPercent).toBeUndefined();
  });

  it("bills sort by due date with human labels; only next-30-days count in the total", () => {
    const events = sequenced([
      billUpserted(deps, { billId: "far", name: "Insurance", expectedAmountMinor: 12_000, nextDue: "2026-09-01" }),
      billUpserted(deps, { billId: "soon", name: "Electricity", expectedAmountMinor: 7_430, nextDue: "2026-07-15" }),
      billUpserted(deps, { billId: "today", name: "Rent", expectedAmountMinor: 120_000, nextDue: "2026-07-12" }),
    ]);
    const vm = buildPlanViewModel({ events, todayLocal: "2026-07-12" });

    expect(vm.bills.map((b) => b.name)).toEqual(["Rent", "Electricity", "Insurance"]); // sorted
    expect(vm.bills[0]!.dueLabel).toBe("due today");
    expect(vm.bills[1]!.dueLabel).toBe("due in 3 days");
    expect(vm.bills[1]!.soon).toBe(true);
    expect(vm.bills[2]!.soon).toBe(false);
    // Rent + Electricity are within 30 days; Insurance (51 days out) is not.
    expect(vm.upcoming30dFormatted).toBe("$1,274.30");
  });

  it("overdue bills read as overdue", () => {
    const events = sequenced([
      billUpserted(deps, { billId: "late", name: "Gym", expectedAmountMinor: 3_000, nextDue: "2026-07-10" }),
    ]);
    const vm = buildPlanViewModel({ events, todayLocal: "2026-07-12" });
    expect(vm.bills[0]!.dueLabel).toBe("2 days overdue");
    expect(vm.bills[0]!.soon).toBe(true);
  });
});
