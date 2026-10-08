import type { UnsequencedEvent } from "../eventStore";

/**
 * Small persistence interfaces the ACL depends on, with in-memory reference
 * implementations (Postgres adapters come with the persistence milestone).
 */

export interface PlaidItem {
  itemId: string;
  userId: string;
  /** Opaque reference — the actual access token lives in encrypted storage
   * server-side only (docs/SecurityPrivacy.md). */
  accessTokenRef: string;
  cursor: string;
  status?: PlaidConnectionStatus;
  lastError?: string;
}

export type PlaidConnectionStatus =
  | "importing"
  | "ready"
  | "retry_needed"
  | "reauthentication_needed"
  | "disconnecting"
  | "disconnected";

export interface ItemStore {
  get(itemId: string): Promise<PlaidItem | undefined>;
  listForUser(userId: string): Promise<PlaidItem[]>;
  put(item: PlaidItem): Promise<void>;
  setCursor(itemId: string, cursor: string): Promise<void>;
  setStatus(itemId: string, status: PlaidConnectionStatus, lastError?: string): Promise<void>;
  markDisconnected(itemId: string): Promise<void>;
}

/**
 * Remembers which user a link token was issued to, so /plaid/complete can
 * refuse a token that isn't the caller's. Without this, anyone holding a
 * link token could complete someone else's bank connection into their own
 * account (docs/SecurityPrivacy.md).
 *
 * Deliberately in-memory: link tokens expire in ~4h, so a restart only means
 * the user re-links. That is a far better failure mode than a new table.
 */
export interface LinkTokenOwners {
  remember(linkToken: string, userId: string): Promise<void>;
  ownerOf(linkToken: string): Promise<string | undefined>;
  forget(linkToken: string): Promise<void>;
}

/** Link tokens Plaid issues are valid ~4h; forget ours a little after that. */
const LINK_TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

export class InMemoryLinkTokenOwners implements LinkTokenOwners {
  private readonly owners = new Map<string, { userId: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async remember(linkToken: string, userId: string) {
    this.sweep();
    this.owners.set(linkToken, { userId, expiresAt: this.now() + LINK_TOKEN_TTL_MS });
  }

  async ownerOf(linkToken: string) {
    const entry = this.owners.get(linkToken);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.owners.delete(linkToken);
      return undefined;
    }
    return entry.userId;
  }
  async forget(linkToken: string) {
    this.owners.delete(linkToken);
  }

  /** Bounded memory: drop expired entries whenever we add one. */
  private sweep() {
    const now = this.now();
    for (const [token, entry] of this.owners) {
      if (entry.expiresAt <= now) this.owners.delete(token);
    }
  }
}

/**
 * Which canonical transaction ids a user already has, plus the alias from a
 * posted Plaid id back to the canonical (originally pending) id. Needed for
 * the pending→posted rewrite (docs/adr/ADR-003-events.md).
 */
export interface TxnRegistry {
  has(userId: string, txnId: string): Promise<boolean>;
  add(userId: string, txnId: string): Promise<void>;
  aliasFor(userId: string, plaidId: string): Promise<string | undefined>;
  addAlias(userId: string, plaidId: string, canonicalId: string): Promise<void>;
}

export interface PlaidIngestionCommit {
  itemId: string;
  userId: string;
  expectedCursor: string;
  nextCursor: string;
  events: readonly UnsequencedEvent[];
  knownTxnIds: readonly string[];
  aliases: readonly { plaidId: string; canonicalId: string }[];
}

export interface PlaidIngestionCommitResult {
  /** False means another worker advanced the item; caller must refetch. */
  committed: boolean;
  appended: number;
}

/** One consistency boundary for event log + identity registry + cursor. */
export interface PlaidIngestionStore {
  knownTxnIds(userId: string, txnIds: readonly string[]): Promise<Set<string>>;
  aliasesFor(userId: string, plaidIds: readonly string[]): Promise<Map<string, string>>;
  commit(input: PlaidIngestionCommit): Promise<PlaidIngestionCommitResult>;
}

export class InMemoryItemStore implements ItemStore {
  private readonly items = new Map<string, PlaidItem>();
  async get(itemId: string) {
    return this.items.get(itemId);
  }
  async listForUser(userId: string) {
    return [...this.items.values()].filter((item) => item.userId === userId).map((item) => ({ ...item }));
  }
  async put(item: PlaidItem) {
    // Ownership is immutable — mirrors the Postgres adapter's guarded upsert.
    const existing = this.items.get(item.itemId);
    if (existing && existing.userId !== item.userId) return;
    this.items.set(item.itemId, { ...item, status: item.status ?? "ready" });
  }
  async setCursor(itemId: string, cursor: string) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`unknown plaid item ${itemId}`);
    item.cursor = cursor;
  }
  async setStatus(itemId: string, status: PlaidConnectionStatus, lastError?: string) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`unknown plaid item ${itemId}`);
    if (item.status === "disconnected" || (item.status === "disconnecting" && status !== "disconnecting")) return;
    item.status = status;
    if (lastError === undefined) delete item.lastError;
    else item.lastError = lastError;
  }
  async markDisconnected(itemId: string) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`unknown plaid item ${itemId}`);
    item.status = "disconnected";
    item.accessTokenRef = "";
    delete item.lastError;
  }
}

export type PlaidJobKind = "sync" | "disconnect";
export type PlaidJobStatus =
  | "queued"
  | "running"
  | "retry_needed"
  | "reauthentication_needed"
  | "completed";

export interface PlaidJob {
  jobId: string;
  itemId: string;
  userId: string;
  kind: PlaidJobKind;
  status: PlaidJobStatus;
  attempts: number;
  nextAttemptAt: string;
  leaseUntil?: string;
  lastError?: string;
}

export interface PlaidJobStore {
  enqueue(itemId: string, userId: string, kind: PlaidJobKind, now: string): Promise<PlaidJob>;
  claimNext(now: string, leaseUntil: string): Promise<PlaidJob | undefined>;
  claim(itemId: string, kind: PlaidJobKind, now: string, leaseUntil: string): Promise<PlaidJob | undefined>;
  complete(jobId: string): Promise<void>;
  fail(
    jobId: string,
    status: "retry_needed" | "reauthentication_needed",
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void>;
  getForItem(itemId: string, kind: PlaidJobKind): Promise<PlaidJob | undefined>;
}

/** Deterministic reference implementation for route and worker tests. */
export class InMemoryPlaidJobStore implements PlaidJobStore {
  private readonly jobs = new Map<string, PlaidJob>();
  private nextId = 0;

  async enqueue(itemId: string, userId: string, kind: PlaidJobKind, now: string) {
    const key = `${itemId}:${kind}`;
    const existing = this.jobs.get(key);
    if (existing && ["queued", "running", "retry_needed"].includes(existing.status)) {
      if (existing.status !== "running") {
        existing.status = "queued";
        existing.nextAttemptAt = now;
        delete existing.lastError;
      }
      return { ...existing };
    }
    const job: PlaidJob = {
      jobId: `plaid-job-${++this.nextId}`,
      itemId,
      userId,
      kind,
      status: "queued",
      attempts: 0,
      nextAttemptAt: now,
    };
    this.jobs.set(key, job);
    return { ...job };
  }

  async claimNext(now: string, leaseUntil: string) {
    const current = Date.parse(now);
    const job = [...this.jobs.values()].find(
      (candidate) =>
        ((candidate.status === "queued" || candidate.status === "retry_needed") &&
          Date.parse(candidate.nextAttemptAt) <= current) ||
        (candidate.status === "running" && Date.parse(candidate.leaseUntil ?? "") <= current),
    );
    return job ? this.claimJob(job, leaseUntil) : undefined;
  }

  async claim(itemId: string, kind: PlaidJobKind, now: string, leaseUntil: string) {
    const job = this.jobs.get(`${itemId}:${kind}`);
    const current = Date.parse(now);
    const due =
      job &&
      (((job.status === "queued" || job.status === "retry_needed") &&
        Date.parse(job.nextAttemptAt) <= current) ||
        (job.status === "running" && Date.parse(job.leaseUntil ?? "") <= current));
    return due && job ? this.claimJob(job, leaseUntil) : undefined;
  }

  private claimJob(job: PlaidJob, leaseUntil: string): PlaidJob {
    job.status = "running";
    job.attempts += 1;
    job.leaseUntil = leaseUntil;
    return { ...job };
  }

  async complete(jobId: string) {
    const job = this.find(jobId);
    job.status = "completed";
    delete job.leaseUntil;
    delete job.lastError;
  }

  async fail(
    jobId: string,
    status: "retry_needed" | "reauthentication_needed",
    nextAttemptAt: string,
    lastError: string,
  ) {
    const job = this.find(jobId);
    job.status = status;
    job.nextAttemptAt = nextAttemptAt;
    delete job.leaseUntil;
    job.lastError = lastError;
  }

  async getForItem(itemId: string, kind: PlaidJobKind) {
    const job = this.jobs.get(`${itemId}:${kind}`);
    return job ? { ...job } : undefined;
  }

  private find(jobId: string): PlaidJob {
    const job = [...this.jobs.values()].find((candidate) => candidate.jobId === jobId);
    if (!job) throw new Error(`unknown Plaid job ${jobId}`);
    return job;
  }
}

/** Atomic boundary for the two lifecycle transitions that must not lose
 * their corresponding durable job. */
export interface PlaidConnectionLifecycleStore {
  startConnection(item: PlaidItem, now: string): Promise<void>;
  requestDisconnect(itemId: string, userId: string, now: string): Promise<boolean>;
}

export class InMemoryPlaidConnectionLifecycleStore implements PlaidConnectionLifecycleStore {
  constructor(
    private readonly items: ItemStore,
    private readonly jobs: PlaidJobStore,
  ) {}

  async startConnection(item: PlaidItem, now: string) {
    await this.items.put({ ...item, status: "importing" });
    await this.jobs.enqueue(item.itemId, item.userId, "sync", now);
  }

  async requestDisconnect(itemId: string, userId: string, now: string) {
    const item = await this.items.get(itemId);
    if (!item || item.userId !== userId) return false;
    if (item.status === "disconnected") return true;
    await this.items.setStatus(itemId, "disconnecting");
    await this.jobs.enqueue(itemId, userId, "disconnect", now);
    return true;
  }
}

export class InMemoryTxnRegistry implements TxnRegistry {
  private readonly known = new Map<string, Set<string>>();
  private readonly aliases = new Map<string, Map<string, string>>();

  async has(userId: string, txnId: string) {
    return this.known.get(userId)?.has(txnId) ?? false;
  }
  async add(userId: string, txnId: string) {
    let set = this.known.get(userId);
    if (!set) this.known.set(userId, (set = new Set()));
    set.add(txnId);
  }
  async aliasFor(userId: string, plaidId: string) {
    return this.aliases.get(userId)?.get(plaidId);
  }
  async addAlias(userId: string, plaidId: string, canonicalId: string) {
    let map = this.aliases.get(userId);
    if (!map) this.aliases.set(userId, (map = new Map()));
    map.set(plaidId, canonicalId);
  }
}

/** Reference atomic adapter. JavaScript execution is synchronous between its
 * awaited store calls, and the cursor compare acts as the commit CAS. */
export class InMemoryPlaidIngestionStore implements PlaidIngestionStore {
  private readonly commitTails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly events: import("../eventStore").EventStore,
    private readonly items: ItemStore,
    private readonly registry: TxnRegistry,
  ) {}

  async knownTxnIds(userId: string, txnIds: readonly string[]) {
    const found = await Promise.all(
      [...new Set(txnIds)].map(async (id) => [id, await this.registry.has(userId, id)] as const),
    );
    return new Set(found.filter(([, known]) => known).map(([id]) => id));
  }

  async aliasesFor(userId: string, plaidIds: readonly string[]) {
    const found = await Promise.all(
      [...new Set(plaidIds)].map(async (id) => [id, await this.registry.aliasFor(userId, id)] as const),
    );
    return new Map(
      found.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    );
  }

  async commit(input: PlaidIngestionCommit): Promise<PlaidIngestionCommitResult> {
    const previous = this.commitTails.get(input.itemId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.commitUnlocked(input));
    this.commitTails.set(input.itemId, current);
    try {
      return await current;
    } finally {
      if (this.commitTails.get(input.itemId) === current) this.commitTails.delete(input.itemId);
    }
  }

  private async commitUnlocked(input: PlaidIngestionCommit): Promise<PlaidIngestionCommitResult> {
    const item = await this.items.get(input.itemId);
    if (!item || item.userId !== input.userId) throw new Error(`unknown plaid item ${input.itemId}`);
    if (item.status === "disconnecting" || item.status === "disconnected") throw new Error("Bank disconnected during import");
    if (item.cursor !== input.expectedCursor) return { committed: false, appended: 0 };

    const result = await this.events.appendBatch(
      input.userId,
      input.events,
      `plaid-update:${input.itemId}:${input.expectedCursor}->${input.nextCursor}`,
    );
    for (const id of input.knownTxnIds) await this.registry.add(input.userId, id);
    for (const alias of input.aliases) {
      await this.registry.addAlias(input.userId, alias.plaidId, alias.canonicalId);
    }
    await this.items.setCursor(input.itemId, input.nextCursor);
    return { committed: true, appended: result.appended.length };
  }
}
