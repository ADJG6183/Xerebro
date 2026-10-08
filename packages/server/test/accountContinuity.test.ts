import { describe, expect, it } from "vitest";
import { buildSnapshot, effectiveTransactions, historyExclusions, type Account, type ContinuityCommand } from "@xerebro/engines";
import { continuityProposals, parseContinuityCommand, readHistory, reviewAccountHistory } from "../src/accountContinuity";
import { buildApp } from "../src/app";
import type { UnsequencedEvent } from "../src/eventStore";
import { syncPlaidBalances } from "../src/plaid/balances";
import { processNextPlaidJob } from "../src/plaid/lifecycle";
import { makeDeps, page, registerHeaders } from "./helpers";

const account = (id: string, status: Account["status"]): Account => ({ accountId: id, source: "plaid", name: "Checking", type: "checking", currency: "USD",
  status, balanceCurrentMinor: 10000, balanceAsOf: "2026-09-10T23:30:00Z", plaidItemId: `item-${id}` });
const transaction = (id: string, accountId: string) => ({ txnId: id, accountId, amountMinor: -1000, currency: "USD", status: "posted", postedDate: "2026-09-10", merchantRaw: "COFFEE", categorySource: "plaid" });
async function seed(deps: Awaited<ReturnType<typeof makeDeps>>, type: string, payload: unknown) {
  const eventId = deps.newEventId();
  const event: UnsequencedEvent = { eventId, type, payload, idempotencyKey: eventId, schemaVersion: 1, source: "system", occurredAt: deps.now() };
  await deps.events.appendBatch("user-1", [event], eventId);
}
async function setup() {
  const deps = await makeDeps({});
  await seed(deps, "AccountUpserted", account("old", "disconnected"));
  await seed(deps, "BankSyncCompleted", { itemId: "item-old", completedAt: "2026-09-10T23:30:00Z" });
  await seed(deps, "AccountUpserted", account("new", "active"));
  await seed(deps, "AccountContinuitySet", { accountId: "new", decision: "pending", candidates: [{ accountId: "old", lastSyncedAt: "2026-09-10T23:30:00Z" }] });
  await seed(deps, "TransactionPosted", transaction("old-t", "old"));
  await seed(deps, "TransactionPosted", transaction("new-t", "new"));
  return deps;
}
const accountCommand = (overrides: Partial<Extract<ContinuityCommand, { kind: "account" }>> = {}): ContinuityCommand => ({
  kind: "account", commandId: "account-choice", accountId: "new", expectedVersion: 4, decision: "same", predecessorId: "old", timeZone: "America/New_York", ...overrides,
});
async function transactionCommand(deps: Awaited<ReturnType<typeof makeDeps>>, txnId = "new-t", commandId = "match"): Promise<ContinuityCommand> {
  const p = buildSnapshot(await readHistory(deps.events, "user-1")).transactions;
  return { kind: "transaction", commandId, txnId, expectedVersion: p.transactions.get(txnId)!.lastSequence,
    continuityVersion: p.continuity!.get("new")!.lastSequence, decision: "duplicate", originalTxnId: "old-t" };
}

describe("account history commands", () => {
  it("requires confirmation, uses the user's local handoff day, and preserves both source records", async () => {
    const deps = await setup();
    const command = accountCommand({ timeZone: "Asia/Tokyo" });
    await reviewAccountHistory(deps, "user-1", command);
    let p = buildSnapshot(await readHistory(deps.events, "user-1")).transactions;
    expect(p.continuity!.get("new")?.cutoffDate).toBe("2026-09-11");
    expect(effectiveTransactions(p)).toHaveLength(1);
    await reviewAccountHistory(deps, "user-1", await transactionCommand(deps));
    p = buildSnapshot(await readHistory(deps.events, "user-1")).transactions;
    expect(p.transactions.size).toBe(2);
    expect(historyExclusions(p).get("new-t")).toBe("confirmed_duplicate");
  });

  it("retries are idempotent; a reused command ID cannot change the decision", async () => {
    const deps = await setup(); const command = accountCommand();
    await reviewAccountHistory(deps, "user-1", command);
    const sequence = await deps.events.lastSequence("user-1");
    await reviewAccountHistory(deps, "user-1", command);
    expect(await deps.events.lastSequence("user-1")).toBe(sequence);
    await expect(reviewAccountHistory(deps, "user-1", accountCommand({ decision: "different" }))).rejects.toThrow("already used");
    await expect(reviewAccountHistory(deps, "user-1", accountCommand({ commandId: "stale" }))).rejects.toThrow("history changed");
  });

  it("extends review over transactions saved after the last completion checkpoint", async () => {
    const deps = await setup();
    await seed(deps, "TransactionPosted", { ...transaction("late-original", "old"), postedDate: "2026-09-13" });
    await seed(deps, "TransactionPosted", { ...transaction("late-repeat", "new"), postedDate: "2026-09-13" });
    await reviewAccountHistory(deps, "user-1", accountCommand());
    const p = buildSnapshot(await readHistory(deps.events, "user-1")).transactions;
    expect(p.continuity!.get("new")?.cutoffDate).toBe("2026-09-13");
    expect(historyExclusions(p).get("late-repeat")).toBe("overlap_review");
  });

  it("two identical-looking purchases cannot claim the same original concurrently", async () => {
    const deps = await setup();
    await seed(deps, "TransactionPosted", transaction("second-new", "new"));
    await reviewAccountHistory(deps, "user-1", accountCommand());
    const results = await Promise.allSettled([
      reviewAccountHistory(deps, "user-1", await transactionCommand(deps, "new-t", "a")),
      reviewAccountHistory(deps, "user-1", await transactionCommand(deps, "second-new", "b")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const p = buildSnapshot(await readHistory(deps.events, "user-1")).transactions;
    expect([...historyExclusions(p).values()].sort()).toEqual(["confirmed_duplicate", "overlap_review"]);
  });

  it("one predecessor cannot be assigned to two replacement accounts", async () => {
    const deps = await setup();
    await seed(deps, "AccountUpserted", account("another", "active"));
    await seed(deps, "AccountContinuitySet", { accountId: "another", decision: "pending", candidates: [{ accountId: "old" }] });
    const results = await Promise.allSettled([
      reviewAccountHistory(deps, "user-1", accountCommand()),
      reviewAccountHistory(deps, "user-1", accountCommand({ commandId: "other", accountId: "another", expectedVersion: 8 })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("does not acknowledge a conflicting concurrent reuse of a command ID", async () => {
    const deps = await setup();
    const results = await Promise.allSettled([
      reviewAccountHistory(deps, "user-1", accountCommand()),
      reviewAccountHistory(deps, "user-1", accountCommand({ decision: "different" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await deps.events.lastSequence("user-1")).toBe(7);
  });

  it("supports repeat reconnects against the retained ancestor, with undo", async () => {
    const deps = await setup();
    await reviewAccountHistory(deps, "user-1", accountCommand());
    await reviewAccountHistory(deps, "user-1", await transactionCommand(deps));
    await seed(deps, "AccountUpserted", account("new", "disconnected"));
    await seed(deps, "AccountUpserted", account("third", "active"));
    await seed(deps, "AccountContinuitySet", { accountId: "third", decision: "pending", candidates: [{ accountId: "new" }] });
    await seed(deps, "TransactionPosted", transaction("third-t", "third"));
    await reviewAccountHistory(deps, "user-1", accountCommand({ commandId: "third", accountId: "third", expectedVersion: 11, predecessorId: "new" }));
    await reviewAccountHistory(deps, "user-1", { kind: "transaction", commandId: "third-match", txnId: "third-t", expectedVersion: 12,
      continuityVersion: 13, decision: "duplicate", originalTxnId: "old-t" });
    let p = buildSnapshot(await readHistory(deps.events, "user-1")).transactions;
    expect(effectiveTransactions(p)).toHaveLength(1);
    await reviewAccountHistory(deps, "user-1", { kind: "transaction", commandId: "undo", txnId: "third-t", expectedVersion: 14,
      continuityVersion: 13, decision: "reopen" });
    p = buildSnapshot(await readHistory(deps.events, "user-1")).transactions;
    expect(historyExclusions(p).get("third-t")).toBe("overlap_review");
  });

  it("a distinct account restores its independent spending", async () => {
    const deps = await setup();
    await reviewAccountHistory(deps, "user-1", accountCommand({ decision: "different" }));
    expect(effectiveTransactions(buildSnapshot(await readHistory(deps.events, "user-1")).transactions)).toHaveLength(2);
  });

  it("SECURITY: enforces authenticated ownership and blocks direct review-event writes", async () => {
    const deps = await setup(); const app = await buildApp(deps);
    const owner = await registerHeaders(app); const stranger = await registerHeaders(app);
    const unauthorized = await app.inject({ method: "POST", url: "/accounts/history-review", payload: accountCommand() });
    expect(unauthorized.statusCode).toBe(401);
    const other = await app.inject({ method: "POST", url: "/accounts/history-review", headers: stranger.headers, payload: accountCommand() });
    expect(other.statusCode).toBe(404);
    const saved = await app.inject({ method: "POST", url: "/accounts/history-review", headers: owner.headers, payload: accountCommand() });
    expect(saved.statusCode).toBe(200);
    const forged = await app.inject({ method: "POST", url: "/events", headers: owner.headers, payload: { events: [{ eventId: "forged", idempotencyKey: "forged", type: "AccountContinuitySet", schemaVersion: 1, occurredAt: deps.now(), source: "user", payload: { accountId: "new", candidates: [], decision: "different" } }] } });
    expect([400, 403]).toContain(forged.statusCode);
    await app.close();
  });

  it("rejects malformed commands before mutation", () => {
    expect(() => parseContinuityCommand({})).toThrow();
    expect(() => parseContinuityCommand(accountCommand({ timeZone: "not/a-zone" }))).toThrow("time zone");
  });

  it("atomically proposes continuity with first balances and never guesses a checkpoint", async () => {
    const deps = await makeDeps({});
    await seed(deps, "AccountUpserted", account("old", "disconnected"));
    deps.plaid.accountsBalanceGet = async () => [{ account_id: "brand-new", name: "Checking", type: "depository", subtype: "checking", mask: "1234", balances: { current: 100, available: 100, iso_currency_code: "USD" } }];
    await syncPlaidBalances(deps, "item-1");
    const snapshot = buildSnapshot(await readHistory(deps.events, "user-1"));
    expect(snapshot.accounts).toHaveLength(2);
    expect(snapshot.transactions.continuity!.get("brand-new")).toMatchObject({ decision: "pending", candidates: [{ accountId: "old" }] });
    expect(snapshot.transactions.continuity!.get("brand-new")!.candidates[0]?.lastSyncedAt).toBeUndefined();
    await syncPlaidBalances(deps, "item-1");
    expect(await deps.events.lastSequence("user-1")).toBe(3);
  });

  it("refuses an upstream account ID collision with existing history", () => {
    const snapshot = buildSnapshot([{ eventId: "a", idempotencyKey: "a", type: "AccountUpserted", payload: account("old", "disconnected"), sequence: 1, schemaVersion: 1, source: "plaid", occurredAt: "2026-09-10T00:00:00Z" }]);
    expect(() => continuityProposals(snapshot, [account("old", "active")])).toThrow("identity conflicts");
  });

  it("does not import unguarded history when reconnection account details are unavailable", async () => {
    const deps = await makeDeps({ "": page({}, "c1") });
    await seed(deps, "AccountUpserted", account("old", "disconnected"));
    await deps.jobs!.enqueue("item-1", "user-1", "sync", deps.now());
    await processNextPlaidJob({ ...deps, jobs: deps.jobs! }, () => new Date(deps.now()));
    expect((await deps.items.get("item-1"))?.cursor).toBe("");
    expect((await deps.items.get("item-1"))?.status).toBe("retry_needed");
  });

  it.each([true, false])("records a checkpoint only after a complete successful import: %s", async (succeeds) => {
    const deps = await makeDeps(succeeds ? { "": page({}, "c1") } : {});
    deps.plaid.accountsBalanceGet = async () => [{ account_id: "brand-new", name: "Checking", type: "depository", subtype: "checking", mask: "1234", balances: { current: 100, available: 100, iso_currency_code: "USD" } }];
    await deps.jobs!.enqueue("item-1", "user-1", "sync", deps.now());
    await processNextPlaidJob({ ...deps, jobs: deps.jobs! }, () => new Date(deps.now()));
    const p = buildSnapshot(await readHistory(deps.events, "user-1")).transactions;
    expect(p.syncCheckpoints?.get("item-1")).toBe(succeeds ? deps.now() : undefined);
  });

  it("a disconnect during fetching prevents a late transaction commit or revived connection", async () => {
    const deps = await makeDeps({});
    deps.plaid.transactionsSync = async () => { await deps.items.setStatus("item-1", "disconnecting"); return page({}, "c1"); };
    await deps.jobs!.enqueue("item-1", "user-1", "sync", deps.now());
    await processNextPlaidJob({ ...deps, jobs: deps.jobs! }, () => new Date(deps.now()));
    expect((await deps.items.get("item-1"))?.status).toBe("disconnecting");
    expect((await deps.items.get("item-1"))?.cursor).toBe("");
    expect(await deps.events.lastSequence("user-1")).toBe(0);
  });
});
