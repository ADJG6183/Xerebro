/**
 * The cache must be INVISIBLE: every view built from it has to match one
 * built by folding the whole log from scratch. These tests compare the two
 * paths directly — if they ever diverge, the optimization is unsafe.
 */
import { describe, expect, it } from "vitest";
import { buildSnapshot, type EventEnvelope } from "@xerebro/engines";
import { buildDashboardViewModel } from "../src/data/dashboardModel";
import { InMemoryDeviceLog, type DeviceEventLog } from "../src/data/deviceLog";
import { createProjectionCache } from "../src/data/projectionCache";
import { accountUpserted, manualTransaction, type EventFactoryDeps } from "../src/data/userEvents";

const NOW = "2026-07-12T10:00:00.000Z";
const TODAY = "2026-07-12";

function factory(deviceId: string): EventFactoryDeps {
  let n = 0;
  return { newId: () => `${deviceId}-${++n}`, nowIso: () => NOW, deviceId };
}

/** Sequence a batch of outgoing events as if the server had accepted them. */
function sequenced(events: ReturnType<typeof manualTransaction>[], from = 0): EventEnvelope[] {
  return events.map((e, i) => ({ ...e, sequence: from + i + 1 }) as EventEnvelope);
}

const deps = factory("device-a");

const ACCOUNT = accountUpserted(deps, {
  accountId: "acct-1",
  type: "checking",
  source: "manual",
  name: "My Checking",
  currency: "USD",
  balanceCurrentMinor: 0,
  balanceAsOf: NOW,
  status: "active",
  openingBalanceMinor: 500_000,
});

const txn = (id: string, amountMinor: number) =>
  manualTransaction(deps, {
    txnId: id,
    accountId: "acct-1",
    amountMinor,
    currency: "USD",
    status: "posted",
    postedDate: TODAY,
    merchantRaw: id,
    categorySource: "user",
  });

describe("projection cache", () => {
  it("cached dashboard === dashboard folded from scratch, after incremental appends", async () => {
    const log = new InMemoryDeviceLog();
    const cache = createProjectionCache();

    // Append in three batches, reading through the cache between each —
    // exactly the pattern a running app produces.
    await log.append(sequenced([ACCOUNT, txn("t-1", -6_842)]));
    await cache.current(log);
    await log.append(sequenced([txn("t-2", 240_000)], 2));
    await cache.current(log);
    await log.append(sequenced([txn("t-3", -1_500)], 3));

    const cached = buildDashboardViewModel({
      snapshot: await cache.current(log),
      todayLocal: TODAY,
      nowIso: NOW,
    });
    const fromScratch = buildDashboardViewModel({
      snapshot: buildSnapshot(await log.all()),
      todayLocal: TODAY,
      nowIso: NOW,
    });

    expect(cached).toEqual(fromScratch);
    expect(cached.availableCashFormatted).toBe("$7,316.58"); // 5,000 − 68.42 + 2,400 − 15
  });

  it("returns the SAME object when nothing new arrived (no wasted folding)", async () => {
    const log = new InMemoryDeviceLog();
    const cache = createProjectionCache();
    await log.append(sequenced([ACCOUNT]));

    const first = await cache.current(log);
    const second = await cache.current(log);
    expect(second).toBe(first);
  });

  it("pending outbox events render optimistically WITHOUT polluting the cache", async () => {
    const log = new InMemoryDeviceLog();
    const cache = createProjectionCache();
    await log.append(sequenced([ACCOUNT]));

    const pending = [txn("t-pending", -2_500)];
    const optimistic = await cache.withPending(log, pending);
    expect(optimistic.transactions.transactions.has("t-pending")).toBe(true);

    // The committed cache must be untouched by the optimistic overlay.
    const committed = await cache.current(log);
    expect(committed.transactions.transactions.has("t-pending")).toBe(false);
  });

  it("drops pending events the server already accepted (flush-then-pull window)", async () => {
    const log = new InMemoryDeviceLog();
    const cache = createProjectionCache();
    const queued = txn("t-1", -6_842);

    // The event is committed to the log, but still sitting in the outbox.
    await log.append(sequenced([ACCOUNT, queued]));

    const snapshot = await cache.withPending(log, [queued]);
    // Counted ONCE — not double-applied as committed + pending.
    expect(snapshot.transactions.transactions.size).toBe(1);
  });

  it("invalidate() forces a clean re-fold that still matches from-scratch", async () => {
    const log = new InMemoryDeviceLog();
    const cache = createProjectionCache();
    await log.append(sequenced([ACCOUNT, txn("t-1", -1_000)]));
    await cache.current(log);

    cache.invalidate();
    const rebuilt = await cache.current(log);
    expect(rebuilt).toEqual(buildSnapshot(await log.all()));
  });

  it("reads only the delta via since(), never reloading already-folded history", async () => {
    const log = new InMemoryDeviceLog();
    const sinceArgs: number[] = [];
    const sinceCounts: number[] = [];
    let allCalls = 0;
    const counting: DeviceEventLog = {
      lastSequence: () => log.lastSequence(),
      append: (events) => log.append(events),
      all: () => {
        allCalls += 1;
        return log.all();
      },
      since: async (after) => {
        sinceArgs.push(after);
        const events = await log.since(after);
        sinceCounts.push(events.length);
        return events;
      },
    };
    const cache = createProjectionCache();

    await log.append(sequenced([ACCOUNT, txn("t-1", -1_000)]));
    await cache.current(counting);
    await log.append(sequenced([txn("t-2", -2_000)], 2));
    await cache.current(counting);
    await log.append(sequenced([txn("t-3", -3_000)], 3));
    await cache.current(counting);

    expect(allCalls).toBe(0); // the cache never falls back to the full-log read
    expect(sinceArgs).toEqual([0, 2, 3]); // asked only for what's new each time
    expect(sinceCounts).toEqual([2, 1, 1]); // and got only that much back
  });
});
