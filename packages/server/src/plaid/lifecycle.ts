import { foldAccounts } from "@xerebro/engines";
import { readHistory } from "../accountContinuity";
import type { EventEnvelope } from "@xerebro/engines";
import type { UnsequencedEvent } from "../eventStore";
import { syncPlaidItem, accessTokenOf, type AclDeps } from "./acl";
import { syncPlaidBalances } from "./balances";
import { classifyAggregatorError } from "./errors";
import { PlaidApiError } from "./httpGateway";
import type { PlaidJob, PlaidJobStore } from "./stores";

export interface PlaidLifecycleDeps extends AclDeps {
  jobs: PlaidJobStore;
}

const LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/** Claims and executes at most one durable job. Safe for multiple workers. */
export async function processNextPlaidJob(
  deps: PlaidLifecycleDeps,
  clock: () => Date = () => new Date(),
): Promise<PlaidJob | undefined> {
  const started = clock();
  const job = await deps.jobs.claimNext(
    started.toISOString(),
    new Date(started.getTime() + LEASE_MS).toISOString(),
  );
  return job ? processClaimedJob(deps, job, started) : undefined;
}

/** Interactive path: execute only the operation the caller just queued. */
export async function processPlaidJob(
  deps: PlaidLifecycleDeps,
  itemId: string,
  kind: PlaidJob["kind"],
  clock: () => Date = () => new Date(),
): Promise<PlaidJob | undefined> {
  const started = clock();
  const job = await deps.jobs.claim(
    itemId,
    kind,
    started.toISOString(),
    new Date(started.getTime() + LEASE_MS).toISOString(),
  );
  return job ? processClaimedJob(deps, job, started) : undefined;
}

async function processClaimedJob(
  deps: PlaidLifecycleDeps,
  job: PlaidJob,
  started: Date,
): Promise<PlaidJob> {
  try {
    const item = await deps.items.get(job.itemId);
    if (!item || item.userId !== job.userId) throw new Error(`unknown plaid item ${job.itemId}`);

    if (job.kind === "disconnect") {
      await appendDisconnectedAccounts(deps, job.itemId, job.userId);
      if (item.accessTokenRef && !deps.plaid.itemRemove) {
        throw new Error("Plaid item removal is not configured");
      }
      if (item.accessTokenRef && deps.plaid.itemRemove) {
        try {
          await deps.plaid.itemRemove(accessTokenOf(deps, item));
        } catch (error) {
          // A crash after Plaid accepted removal can make the retry see an
          // already-invalid token. That means the desired state was reached.
          if (!isAlreadyRemoved(error)) throw error;
        }
      }
      await deps.items.markDisconnected(job.itemId);
    } else {
      if (item.status === "disconnecting" || item.status === "disconnected") {
        await deps.jobs.complete(job.jobId);
        return job;
      }
      await syncPlaidBalances(deps, job.itemId);
      if (!deps.plaid.accountsBalanceGet) {
        const old = foldAccounts(await readHistory(deps.events, job.userId));
        if (old.some((a) => a.source === "plaid" && a.status === "disconnected")) {
          throw new Error("Account details are required to review a possible reconnection");
        }
      }
      const allowedAccountIds = deps.plaid.accountsBalanceGet ? new Set(
        foldAccounts(await readHistory(deps.events, job.userId))
          .filter((a) => a.source === "plaid" && a.status === "active" && a.plaidItemId === job.itemId)
          .map((a) => a.accountId),
      ) : undefined;
      await syncPlaidItem(deps, job.itemId, allowedAccountIds);
      const latest = await deps.items.get(job.itemId);
      if (latest?.status === "disconnecting" || latest?.status === "disconnected") {
        await deps.jobs.complete(job.jobId);
        return job;
      }
      if (deps.plaid.accountsBalanceGet) {
        const completedAt = deps.now();
        await deps.events.appendBatch(job.userId, [{
          eventId: deps.newEventId(), type: "BankSyncCompleted", schemaVersion: 1,
          occurredAt: completedAt, source: "system", idempotencyKey: `bank-sync:${job.jobId}:${job.attempts}`,
          payload: { itemId: job.itemId, completedAt },
        }], `bank-sync:${job.jobId}:${job.attempts}`);
      }
      await deps.items.setStatus(job.itemId, "ready");
    }
    await deps.jobs.complete(job.jobId);
  } catch (error) {
    const currentItem = await deps.items.get(job.itemId);
    if (job.kind === "sync" && (currentItem?.status === "disconnecting" || currentItem?.status === "disconnected")) {
      await deps.jobs.complete(job.jobId);
      return job;
    }
    const failure = classifyAggregatorError(error);
    const status = failure.kind === "reauth_required" ? "reauthentication_needed" : "retry_needed";
    const delay = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(job.attempts - 1, 10));
    await deps.jobs.fail(
      job.jobId,
      status,
      new Date(started.getTime() + delay).toISOString(),
      failure.userMessage,
    );
    const itemStatus = job.kind === "disconnect" ? "disconnecting" : status;
    await deps.items.setStatus(job.itemId, itemStatus, failure.userMessage);
  }
  return job;
}

function isAlreadyRemoved(error: unknown): boolean {
  return (
    error instanceof PlaidApiError &&
    (error.plaidErrorCode === "INVALID_ACCESS_TOKEN" || error.plaidErrorCode === "ITEM_NOT_FOUND")
  );
}

async function appendDisconnectedAccounts(
  deps: PlaidLifecycleDeps,
  itemId: string,
  userId: string,
): Promise<void> {
  const events = await allEvents(deps, userId);
  const accounts = foldAccounts(events).filter(
    (account) => account.source === "plaid" && account.plaidItemId === itemId,
  );
  if (accounts.length === 0) return;
  const occurredAt = deps.now();
  const updates: UnsequencedEvent[] = accounts.map((account) => ({
    eventId: deps.newEventId(),
    type: "AccountUpserted",
    schemaVersion: 1,
    occurredAt,
    source: "plaid",
    idempotencyKey: `plaid-disconnect:${itemId}:${account.accountId}`,
    payload: { ...account, status: "disconnected" },
  }));
  await deps.events.appendBatch(userId, updates, `plaid-disconnect:${itemId}`);
}

async function allEvents(deps: AclDeps, userId: string): Promise<EventEnvelope[]> {
  const result: EventEnvelope[] = [];
  let since = 0;
  for (;;) {
    const page = await deps.events.eventsSince(userId, since, 500);
    if (page.length === 0) return result;
    result.push(...page);
    since = page[page.length - 1]!.sequence;
  }
}
