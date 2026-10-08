import {
  buildSnapshot, historyExclusions, needsOverlapReview, overlapKey, predecessorIds,
  transactionSignature, type Account, type AccountContinuity, type ContinuityCommand,
  type EventEnvelope, type ProjectionSnapshot,
} from "@xerebro/engines";
import { EventSequenceConflict, type EventStore, type UnsequencedEvent } from "./eventStore";

export class ContinuityError extends Error {
  constructor(message: string, public readonly statusCode = 409) { super(message); }
}

/** A bounded, consistent prefix even if imports keep appending during paging. */
export async function readHistory(store: EventStore, userId: string): Promise<EventEnvelope[]> {
  const through = await store.lastSequence(userId);
  const events: EventEnvelope[] = [];
  let since = 0;
  while (since < through) {
    const page = await store.eventsSince(userId, since, Math.min(500, through - since));
    if (!page.length) throw new Error("Incomplete event history");
    events.push(...page);
    since = page[page.length - 1]!.sequence;
  }
  return events;
}

/** Broad candidates are prompts, never identity evidence or automatic merges. */
export function continuityProposals(snapshot: ProjectionSnapshot, incoming: readonly Account[]): Omit<AccountContinuity, "lastSequence">[] {
  const existing = new Map(snapshot.accounts.map((a) => [a.accountId, a]));
  const used = new Set([...(snapshot.transactions.continuity?.values() ?? [])]
    .filter((c) => c.decision === "same").map((c) => c.predecessorId));
  const candidates = new Map<string, Account[]>();
  for (const account of snapshot.accounts) {
    if (account.source !== "plaid" || account.status !== "disconnected" || used.has(account.accountId)) continue;
    const key = JSON.stringify([account.type, account.currency]);
    const bucket = candidates.get(key) ?? [];
    bucket.push(account);
    candidates.set(key, bucket);
  }
  const proposals: Omit<AccountContinuity, "lastSequence">[] = [];
  for (const account of incoming) {
    const previous = existing.get(account.accountId);
    // Do not overwrite a different source's identity, even if an upstream ID
    // is unexpectedly reused. This import needs diagnosis, not a silent merge.
    if (previous && (previous.source !== "plaid" || previous.plaidItemId !== account.plaidItemId || previous.status !== "active")) {
      throw new ContinuityError("Bank account identity conflicts with saved history.");
    }
    if (previous || snapshot.transactions.continuity?.has(account.accountId)) continue;
    const compatible = candidates.get(JSON.stringify([account.type, account.currency])) ?? [];
    if (!compatible.length) continue;
    proposals.push({ accountId: account.accountId, decision: "pending", candidates: compatible.map((old) => {
      const lastSyncedAt = old.plaidItemId ? snapshot.transactions.syncCheckpoints?.get(old.plaidItemId) : undefined;
      return { accountId: old.accountId, ...(lastSyncedAt ? { lastSyncedAt } : {}) };
    }) });
  }
  return proposals;
}

export function parseContinuityCommand(value: unknown): ContinuityCommand {
  if (!value || typeof value !== "object") throw new ContinuityError("Invalid review request", 400);
  const p = value as Record<string, unknown>;
  const id = (key: string) => typeof p[key] === "string" && (p[key] as string).length > 0 && (p[key] as string).length <= 200;
  if (!id("commandId") || !Number.isSafeInteger(p.expectedVersion) || (p.expectedVersion as number) < 0) throw new ContinuityError("Review ID and version are required", 400);
  if (p.kind === "account" && id("accountId") && id("timeZone") && ["same", "different", "reopen"].includes(p.decision as string)) {
    if (p.decision === "same" && !id("predecessorId")) throw new ContinuityError("Choose a previous account", 400);
    try { new Intl.DateTimeFormat("en", { timeZone: p.timeZone as string }).format(); }
    catch { throw new ContinuityError("Invalid time zone", 400); }
    return { kind: "account", commandId: p.commandId as string, accountId: p.accountId as string,
      expectedVersion: p.expectedVersion as number, decision: p.decision as "same" | "different" | "reopen",
      timeZone: p.timeZone as string, ...(p.decision === "same" ? { predecessorId: p.predecessorId as string } : {}) };
  }
  if (p.kind === "transaction" && id("txnId") && Number.isSafeInteger(p.continuityVersion) && ["duplicate", "unique", "reopen"].includes(p.decision as string)) {
    if (p.decision === "duplicate" && !id("originalTxnId")) throw new ContinuityError("Choose the original transaction", 400);
    return { kind: "transaction", commandId: p.commandId as string, txnId: p.txnId as string,
      expectedVersion: p.expectedVersion as number, continuityVersion: p.continuityVersion as number,
      decision: p.decision as "duplicate" | "unique" | "reopen",
      ...(p.decision === "duplicate" ? { originalTxnId: p.originalTxnId as string } : {}) };
  }
  throw new ContinuityError("Invalid review request", 400);
}

function localDate(timestamp: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function reviewAccountHistory(deps: { events: EventStore; now(): string; newEventId(): string }, userId: string, command: ContinuityCommand): Promise<void> {
  const key = `account-history-review:${command.commandId}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const events = await readHistory(deps.events, userId);
    const prior = events.find((e) => e.idempotencyKey === key);
    if (prior) {
      if (JSON.stringify((prior.payload as { command: unknown }).command) !== JSON.stringify(command)) throw new ContinuityError("Review ID was already used for a different decision");
      return;
    }
    const snapshot = buildSnapshot(events);
    const projection = snapshot.transactions;
    let type: string;
    let payload: object;
    if (command.kind === "account") {
      const continuity = projection.continuity?.get(command.accountId);
      const account = snapshot.accounts.find((a) => a.accountId === command.accountId && a.source === "plaid");
      if (!continuity || !account) throw new ContinuityError("Account review not found", 404);
      if (continuity.lastSequence !== command.expectedVersion) throw new EventSequenceConflict();
      if ([...(projection.continuity?.values() ?? [])].some((c) => c.decision === "same" && c.predecessorId === account.accountId)) throw new ContinuityError("Review the newer connection first before changing its history");
      const candidate = continuity.candidates.find((c) => c.accountId === command.predecessorId);
      let cutoffDate = candidate?.lastSyncedAt ? localDate(candidate.lastSyncedAt, command.timeZone) : undefined;
      if (command.decision === "same") {
        const old = snapshot.accounts.find((a) => a.accountId === command.predecessorId);
        if (!candidate || !old || old.status !== "disconnected" || old.source !== "plaid" || old.currency !== account.currency || old.type !== account.type) throw new ContinuityError("Previous account is no longer eligible");
        if (old.accountId === account.accountId || predecessorIds(projection, old.accountId).has(account.accountId)) throw new ContinuityError("Account history cannot form a loop");
        if ([...(projection.continuity?.values() ?? [])].some((c) => c.accountId !== account.accountId && c.decision === "same" && c.predecessorId === old.accountId)) throw new ContinuityError("That previous account is already connected to another account");
        if (projection.continuity?.get(old.accountId)?.decision === "pending") throw new ContinuityError("Review the previous account's connection first");
        // A process can commit transactions and die before recording completion.
        // Never count those saved later-dated records twice on reconnect. The
        // checkpoint remains the handoff evidence; widen only the review window.
        const chain = predecessorIds(projection, old.accountId).add(old.accountId);
        if (cutoffDate) {
          for (const row of projection.transactions.values()) {
            if (!row.removed && chain.has(row.accountId) && row.postedDate && row.postedDate > cutoffDate) cutoffDate = row.postedDate;
          }
        }
      }
      type = "AccountContinuitySet";
      payload = { accountId: account.accountId, candidates: continuity.candidates,
        decision: command.decision === "reopen" ? "pending" : command.decision,
        ...(command.decision === "same" ? { predecessorId: command.predecessorId,
          ...(cutoffDate ? { cutoffDate } : {}) } : {}) };
    } else {
      const row = projection.transactions.get(command.txnId);
      const continuity = row && projection.continuity?.get(row.accountId);
      const previous = projection.overlapReviews?.get(command.txnId);
      if (!row || row.removed || !continuity || continuity.decision !== "same" || !needsOverlapReview(projection, row)) throw new ContinuityError("Transaction review not found", 404);
      if (Math.max(row.lastSequence, previous?.lastSequence ?? 0) !== command.expectedVersion || continuity.lastSequence !== command.continuityVersion) throw new EventSequenceConflict();
      const original = command.originalTxnId ? projection.transactions.get(command.originalTxnId) : undefined;
      if (command.decision === "duplicate") {
        const excluded = historyExclusions(projection);
        if (!original || !predecessorIds(projection, row.accountId).has(original.accountId) || excluded.has(original.txnId) || !overlapKey(row) || overlapKey(original) !== overlapKey(row)) throw new ContinuityError("These transactions are not an eligible posted match");
        // One-to-one within a single replacement account. A later replacement
        // can legitimately refer to the same retained original in the chain.
        for (const review of projection.overlapReviews?.values() ?? []) {
          if (review.txnId !== row.txnId && review.originalTxnId === original.txnId &&
              projection.transactions.get(review.txnId)?.accountId === row.accountId &&
              excluded.get(review.txnId) === "confirmed_duplicate") throw new ContinuityError("This original already has a matching transaction");
        }
      }
      type = "TransactionOverlapReviewed";
      payload = { txnId: row.txnId, decision: command.decision, signature: transactionSignature(row),
        continuitySequence: continuity.lastSequence,
        ...(command.decision === "duplicate" && original ? { originalTxnId: original.txnId, originalSignature: transactionSignature(original) } : {}) };
    }
    const event: UnsequencedEvent = { eventId: deps.newEventId(), type, schemaVersion: 1,
      occurredAt: deps.now(), source: "user", idempotencyKey: key, payload: { ...payload, command } };
    try {
      const result = await deps.events.appendBatch(userId, [event], key, snapshot.lastSequence);
      if (result.deduped) {
        const winner = (await readHistory(deps.events, userId)).find((e) => e.idempotencyKey === key);
        if (!winner || JSON.stringify((winner.payload as { command: unknown }).command) !== JSON.stringify(command)) {
          throw new ContinuityError("Review ID was already used for a different decision");
        }
      }
      return;
    } catch (error) {
      if (!(error instanceof EventSequenceConflict) || attempt === 2) throw error;
    }
  }
}
