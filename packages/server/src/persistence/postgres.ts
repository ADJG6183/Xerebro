/**
 * Postgres adapters (docs/adr/ADR-002-stack.md) for the three store
 * interfaces. The in-memory implementations remain the executable spec —
 * these adapters must pass the SAME contract tests (test/storeContract.ts).
 *
 * The load-bearing guarantee is the gapless per-user sequence (ADR-003: the
 * server owns THE order). Concurrency-safe via a per-user counter row locked
 * with SELECT ... FOR UPDATE inside the append transaction: two webhooks for
 * the same user serialize; different users don't contend.
 *
 * Schema bootstrap remains self-contained for v1. Additive changes are
 * version-recorded in schema_migrations so deployed databases can be audited
 * and moved to a dedicated migration runner without guessing their state.
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { EventSequenceConflict } from "../eventStore";
import type { EventEnvelope } from "@xerebro/engines";
import {
  hashToken,
  mintPair,
  type AuthDeps,
  type AuthSession,
  type AuthStore,
  type RegisterResult,
} from "../auth/store";
import type { AppendResult, EventStore, UnsequencedEvent } from "../eventStore";
import type {
  ItemStore,
  PlaidConnectionLifecycleStore,
  LinkTokenOwners,
  PlaidIngestionCommit,
  PlaidIngestionCommitResult,
  PlaidIngestionStore,
  PlaidItem,
  PlaidJob,
  PlaidJobKind,
  PlaidJobStore,
  PlaidJobStatus,
  PlaidConnectionStatus,
  TxnRegistry,
} from "../plaid/stores";

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export async function ensureSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sequences (
      user_id text PRIMARY KEY,
      last_sequence bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (
      user_id text NOT NULL,
      sequence bigint NOT NULL,
      event_id text NOT NULL,
      type text NOT NULL,
      schema_version int NOT NULL,
      occurred_at timestamptz NOT NULL,
      source text NOT NULL,
      idempotency_key text NOT NULL,
      payload jsonb NOT NULL,
      PRIMARY KEY (user_id, sequence),
      UNIQUE (user_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS processed_batches (
      user_id text NOT NULL,
      batch_key text NOT NULL,
      PRIMARY KEY (user_id, batch_key)
    );
    CREATE TABLE IF NOT EXISTS plaid_items (
      item_id text PRIMARY KEY,
      user_id text NOT NULL,
      access_token_ref text NOT NULL,
      cursor text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'ready',
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
    ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS last_error text;
    ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS plaid_link_token_owners (
      token_hash text PRIMARY KEY,
      user_id text NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plaid_link_token_owners_expiry
      ON plaid_link_token_owners (expires_at);
    CREATE TABLE IF NOT EXISTS plaid_sync_jobs (
      job_id text PRIMARY KEY,
      item_id text NOT NULL REFERENCES plaid_items(item_id),
      user_id text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      attempts int NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL,
      lease_until timestamptz,
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (item_id, kind)
    );
    CREATE INDEX IF NOT EXISTS plaid_sync_jobs_claim
      ON plaid_sync_jobs (status, next_attempt_at, lease_until);
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version int PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO schema_migrations (version, name)
      VALUES (1, 'durable_plaid_lifecycle') ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS plaid_txn_registry (
      user_id text NOT NULL,
      txn_id text NOT NULL,
      PRIMARY KEY (user_id, txn_id)
    );
    CREATE TABLE IF NOT EXISTS plaid_txn_aliases (
      user_id text NOT NULL,
      plaid_id text NOT NULL,
      canonical_id text NOT NULL,
      PRIMARY KEY (user_id, plaid_id)
    );
    CREATE TABLE IF NOT EXISTS auth_devices (
      device_id text PRIMARY KEY,
      user_id text NOT NULL,
      name text NOT NULL,
      access_hash text NOT NULL,
      access_expires_at timestamptz NOT NULL,
      refresh_hash text NOT NULL,
      refresh_expires_at timestamptz NOT NULL,
      prev_refresh_hash text,
      revoked boolean NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS auth_devices_access_hash ON auth_devices (access_hash);
    CREATE INDEX IF NOT EXISTS auth_devices_refresh_hash ON auth_devices (refresh_hash);
  `);
}

interface EventRow {
  sequence: string; // bigint arrives as string
  event_id: string;
  type: string;
  schema_version: number;
  occurred_at: Date;
  source: EventEnvelope["source"];
  idempotency_key: string;
  payload: unknown;
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    eventId: row.event_id,
    sequence: Number(row.sequence),
    type: row.type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at.toISOString(),
    source: row.source,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
  };
}

export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: pg.Pool) {}

  async appendBatch(
    userId: string,
    events: readonly UnsequencedEvent[],
    batchKey: string,
    expectedSequence?: number,
  ): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Lock this user's counter row (created on first touch). Serializes
      // appends per user — the gapless-sequence guarantee.
      await client.query(
        `INSERT INTO user_sequences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      const seqRes = await client.query<{ last_sequence: string }>(
        `SELECT last_sequence FROM user_sequences WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      let sequence = Number(seqRes.rows[0]!.last_sequence);

      const batch = await client.query(
        `INSERT INTO processed_batches (user_id, batch_key) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, batchKey],
      );
      if (batch.rowCount === 0) {
        await client.query("COMMIT");
        return { appended: [], deduped: true };
      }
      // The existing per-user lock makes validation + append optimistic and
      // atomic; throwing rolls back the new batch key as well as its events.
      if (expectedSequence !== undefined && sequence !== expectedSequence) throw new EventSequenceConflict();

      const appended: EventEnvelope[] = [];
      for (const event of events) {
        const inserted = await client.query(
          `INSERT INTO events
             (user_id, sequence, event_id, type, schema_version, occurred_at, source, idempotency_key, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
          [
            userId,
            sequence + 1,
            event.eventId,
            event.type,
            event.schemaVersion,
            event.occurredAt,
            event.source,
            event.idempotencyKey,
            JSON.stringify(event.payload),
          ],
        );
        if (inserted.rowCount === 1) {
          sequence += 1;
          appended.push({ ...event, sequence });
        }
      }

      await client.query(`UPDATE user_sequences SET last_sequence = $2 WHERE user_id = $1`, [
        userId,
        sequence,
      ]);
      await client.query("COMMIT");
      return { appended, deduped: false };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async eventsSince(userId: string, since: number, limit = 500): Promise<EventEnvelope[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT sequence, event_id, type, schema_version, occurred_at, source, idempotency_key, payload
       FROM events WHERE user_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3`,
      [userId, since, limit],
    );
    return res.rows.map(rowToEnvelope);
  }

  async lastSequence(userId: string): Promise<number> {
    const res = await this.pool.query<{ last_sequence: string }>(
      `SELECT last_sequence FROM user_sequences WHERE user_id = $1`,
      [userId],
    );
    return res.rows[0] ? Number(res.rows[0].last_sequence) : 0;
  }
}

export class PostgresAuthStore implements AuthStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: AuthDeps,
  ) {}

  async registerDevice(deviceName: string): Promise<RegisterResult> {
    const userId = this.deps.newId();
    const deviceId = this.deps.newId();
    const { accessToken, refreshToken, fields } = mintPair(this.deps);
    await this.pool.query(
      `INSERT INTO auth_devices
         (device_id, user_id, name, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        deviceId,
        userId,
        deviceName,
        fields.accessHash,
        fields.accessExpiresAt,
        fields.refreshHash,
        fields.refreshExpiresAt,
      ],
    );
    return {
      userId,
      deviceId,
      accessToken,
      accessExpiresAt: fields.accessExpiresAt,
      refreshToken,
      refreshExpiresAt: fields.refreshExpiresAt,
    };
  }

  async verifyAccess(accessToken: string): Promise<AuthSession | null> {
    const res = await this.pool.query(
      `SELECT user_id, device_id FROM auth_devices
       WHERE access_hash = $1 AND NOT revoked AND access_expires_at > $2`,
      [hashToken(accessToken), this.deps.now()],
    );
    const row = res.rows[0];
    return row ? { userId: row.user_id, deviceId: row.device_id } : null;
  }

  async refresh(refreshToken: string): Promise<RegisterResult | null> {
    const hash = hashToken(refreshToken);

    // Theft signal: a rotated-out token came back → revoke the device.
    const reused = await this.pool.query(
      `UPDATE auth_devices SET revoked = true WHERE prev_refresh_hash = $1 RETURNING device_id`,
      [hash],
    );
    if ((reused.rowCount ?? 0) > 0) return null;

    const { accessToken, refreshToken: nextRefresh, fields } = mintPair(this.deps);
    const res = await this.pool.query(
      `UPDATE auth_devices
         SET prev_refresh_hash = refresh_hash,
             access_hash = $2, access_expires_at = $3,
             refresh_hash = $4, refresh_expires_at = $5
       WHERE refresh_hash = $1 AND NOT revoked AND refresh_expires_at > $6
       RETURNING user_id, device_id`,
      [hash, fields.accessHash, fields.accessExpiresAt, fields.refreshHash, fields.refreshExpiresAt, this.deps.now()],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      deviceId: row.device_id,
      accessToken,
      accessExpiresAt: fields.accessExpiresAt,
      refreshToken: nextRefresh,
      refreshExpiresAt: fields.refreshExpiresAt,
    };
  }
}

export class PostgresItemStore implements ItemStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(itemId: string): Promise<PlaidItem | undefined> {
    const res = await this.pool.query(
      `SELECT item_id, user_id, access_token_ref, cursor, status, last_error
       FROM plaid_items WHERE item_id = $1`,
      [itemId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      itemId: row.item_id,
      userId: row.user_id,
      accessTokenRef: row.access_token_ref,
      cursor: row.cursor,
      status: row.status,
      ...(row.last_error ? { lastError: row.last_error } : {}),
    };
  }

  async listForUser(userId: string): Promise<PlaidItem[]> {
    const res = await this.pool.query(
      `SELECT item_id, user_id, access_token_ref, cursor, status, last_error
       FROM plaid_items WHERE user_id = $1 ORDER BY item_id`,
      [userId],
    );
    return res.rows.map((row) => ({
      itemId: row.item_id,
      userId: row.user_id,
      accessTokenRef: row.access_token_ref,
      cursor: row.cursor,
      status: row.status,
      ...(row.last_error ? { lastError: row.last_error } : {}),
    }));
  }

  async put(item: PlaidItem): Promise<void> {
    await this.pool.query(
      // Re-linking the same item refreshes its token and cursor, but an
      // item's OWNER is immutable: the WHERE makes a put by anyone else
      // update zero rows rather than silently stealing the connection.
      `INSERT INTO plaid_items (item_id, user_id, access_token_ref, cursor, status, last_error)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (item_id) DO UPDATE
         SET access_token_ref = $3, cursor = $4, status = $5,
             last_error = $6, updated_at = now()
         WHERE plaid_items.user_id = $2`,
      [item.itemId, item.userId, item.accessTokenRef, item.cursor, item.status ?? "ready", item.lastError ?? null],
    );
  }

  async setCursor(itemId: string, cursor: string): Promise<void> {
    const res = await this.pool.query(`UPDATE plaid_items SET cursor = $2, updated_at = now() WHERE item_id = $1`, [
      itemId,
      cursor,
    ]);
    if (res.rowCount === 0) throw new Error(`unknown plaid item ${itemId}`);
  }

  async setStatus(itemId: string, status: PlaidConnectionStatus, lastError?: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE plaid_items SET status = $2, last_error = $3, updated_at = now() WHERE item_id = $1
       AND (status NOT IN ('disconnecting', 'disconnected') OR (status = 'disconnecting' AND $2 = 'disconnecting'))`,
      [itemId, status, lastError ?? null],
    );
    if (res.rowCount === 0) {
      const exists = await this.pool.query(`SELECT 1 FROM plaid_items WHERE item_id = $1`, [itemId]);
      if (exists.rowCount === 0) throw new Error(`unknown plaid item ${itemId}`);
    }
  }

  async markDisconnected(itemId: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE plaid_items SET status = 'disconnected', access_token_ref = '',
         last_error = NULL, updated_at = now() WHERE item_id = $1`,
      [itemId],
    );
    if (res.rowCount === 0) throw new Error(`unknown plaid item ${itemId}`);
  }
}

const LINK_TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Stores only a digest of the short-lived Link token. */
export class PostgresLinkTokenOwners implements LinkTokenOwners {
  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async remember(linkToken: string, userId: string): Promise<void> {
    const now = this.now();
    await this.pool.query(`DELETE FROM plaid_link_token_owners WHERE expires_at <= $1`, [now]);
    await this.pool.query(
      `INSERT INTO plaid_link_token_owners (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO UPDATE SET user_id = $2, expires_at = $3`,
      [tokenHash(linkToken), userId, new Date(now.getTime() + LINK_TOKEN_TTL_MS)],
    );
  }

  async ownerOf(linkToken: string): Promise<string | undefined> {
    const res = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM plaid_link_token_owners
       WHERE token_hash = $1 AND expires_at > $2`,
      [tokenHash(linkToken), this.now()],
    );
    return res.rows[0]?.user_id;
  }

  async forget(linkToken: string): Promise<void> {
    await this.pool.query(`DELETE FROM plaid_link_token_owners WHERE token_hash = $1`, [tokenHash(linkToken)]);
  }
}

interface PlaidJobRow {
  job_id: string;
  item_id: string;
  user_id: string;
  kind: PlaidJobKind;
  status: PlaidJobStatus;
  attempts: number;
  next_attempt_at: Date;
  lease_until: Date | null;
  last_error: string | null;
}

function rowToPlaidJob(row: PlaidJobRow): PlaidJob {
  return {
    jobId: row.job_id,
    itemId: row.item_id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    ...(row.lease_until ? { leaseUntil: row.lease_until.toISOString() } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

export class PostgresPlaidJobStore implements PlaidJobStore {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(itemId: string, userId: string, kind: PlaidJobKind, now: string): Promise<PlaidJob> {
    const res = await this.pool.query<PlaidJobRow>(
      `INSERT INTO plaid_sync_jobs
         (job_id, item_id, user_id, kind, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, 'queued', $5)
       ON CONFLICT (item_id, kind) DO UPDATE
         SET status = CASE WHEN plaid_sync_jobs.status = 'running' THEN 'running' ELSE 'queued' END,
             next_attempt_at = CASE WHEN plaid_sync_jobs.status = 'running'
               THEN plaid_sync_jobs.next_attempt_at ELSE EXCLUDED.next_attempt_at END,
             last_error = CASE WHEN plaid_sync_jobs.status = 'running'
               THEN plaid_sync_jobs.last_error ELSE NULL END,
             updated_at = now()
       RETURNING job_id, item_id, user_id, kind, status, attempts,
                 next_attempt_at, lease_until, last_error`,
      [randomUUID(), itemId, userId, kind, now],
    );
    return rowToPlaidJob(res.rows[0]!);
  }

  async claimNext(now: string, leaseUntil: string): Promise<PlaidJob | undefined> {
    const res = await this.pool.query<PlaidJobRow>(
      `WITH candidate AS (
         SELECT job_id FROM plaid_sync_jobs
         WHERE ((status IN ('queued', 'retry_needed') AND next_attempt_at <= $1)
             OR (status = 'running' AND lease_until <= $1))
         ORDER BY next_attempt_at, job_id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE plaid_sync_jobs AS job
       SET status = 'running', attempts = attempts + 1, lease_until = $2, updated_at = now()
       FROM candidate WHERE job.job_id = candidate.job_id
       RETURNING job.job_id, job.item_id, job.user_id, job.kind, job.status,
                 job.attempts, job.next_attempt_at, job.lease_until, job.last_error`,
      [now, leaseUntil],
    );
    return res.rows[0] ? rowToPlaidJob(res.rows[0]) : undefined;
  }

  async claim(
    itemId: string,
    kind: PlaidJobKind,
    now: string,
    leaseUntil: string,
  ): Promise<PlaidJob | undefined> {
    const res = await this.pool.query<PlaidJobRow>(
      `UPDATE plaid_sync_jobs
       SET status = 'running', attempts = attempts + 1, lease_until = $4, updated_at = now()
       WHERE item_id = $1 AND kind = $2
         AND ((status IN ('queued', 'retry_needed') AND next_attempt_at <= $3)
           OR (status = 'running' AND lease_until <= $3))
       RETURNING job_id, item_id, user_id, kind, status, attempts,
                 next_attempt_at, lease_until, last_error`,
      [itemId, kind, now, leaseUntil],
    );
    return res.rows[0] ? rowToPlaidJob(res.rows[0]) : undefined;
  }

  async complete(jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE plaid_sync_jobs SET status = 'completed', lease_until = NULL,
         last_error = NULL, updated_at = now() WHERE job_id = $1`,
      [jobId],
    );
  }

  async fail(
    jobId: string,
    status: "retry_needed" | "reauthentication_needed",
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE plaid_sync_jobs SET status = $2, next_attempt_at = $3,
         lease_until = NULL, last_error = $4, updated_at = now() WHERE job_id = $1`,
      [jobId, status, nextAttemptAt, lastError.slice(0, 500)],
    );
  }

  async getForItem(itemId: string, kind: PlaidJobKind): Promise<PlaidJob | undefined> {
    const res = await this.pool.query<PlaidJobRow>(
      `SELECT job_id, item_id, user_id, kind, status, attempts,
              next_attempt_at, lease_until, last_error
       FROM plaid_sync_jobs WHERE item_id = $1 AND kind = $2`,
      [itemId, kind],
    );
    return res.rows[0] ? rowToPlaidJob(res.rows[0]) : undefined;
  }
}

export class PostgresPlaidConnectionLifecycleStore implements PlaidConnectionLifecycleStore {
  constructor(private readonly pool: pg.Pool) {}

  async startConnection(item: PlaidItem, now: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const stored = await client.query(
        `INSERT INTO plaid_items
           (item_id, user_id, access_token_ref, cursor, status, last_error)
         VALUES ($1, $2, $3, $4, 'importing', NULL)
         ON CONFLICT (item_id) DO UPDATE
           SET access_token_ref = $3, cursor = $4, status = 'importing',
               last_error = NULL, updated_at = now()
           WHERE plaid_items.user_id = $2
         RETURNING item_id`,
        [item.itemId, item.userId, item.accessTokenRef, item.cursor],
      );
      if (stored.rowCount !== 1) throw new Error("Plaid item belongs to another user");
      await client.query(
        `INSERT INTO plaid_sync_jobs
           (job_id, item_id, user_id, kind, status, next_attempt_at)
         VALUES ($1, $2, $3, 'sync', 'queued', $4)
         ON CONFLICT (item_id, kind) DO UPDATE
           SET status = 'queued', next_attempt_at = EXCLUDED.next_attempt_at,
               lease_until = NULL, last_error = NULL, updated_at = now()`,
        [randomUUID(), item.itemId, item.userId, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async requestDisconnect(itemId: string, userId: string, now: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const stored = await client.query<{ status: PlaidConnectionStatus }>(
        `SELECT status FROM plaid_items WHERE item_id = $1 AND user_id = $2 FOR UPDATE`,
        [itemId, userId],
      );
      if (!stored.rows[0]) {
        await client.query("ROLLBACK");
        return false;
      }
      if (stored.rows[0].status === "disconnected") {
        await client.query("COMMIT");
        return true;
      }
      await client.query(
        `UPDATE plaid_items SET status = 'disconnecting', last_error = NULL,
           updated_at = now() WHERE item_id = $1`,
        [itemId],
      );
      await client.query(
        `INSERT INTO plaid_sync_jobs
           (job_id, item_id, user_id, kind, status, next_attempt_at)
         VALUES ($1, $2, $3, 'disconnect', 'queued', $4)
         ON CONFLICT (item_id, kind) DO UPDATE
           SET status = CASE WHEN plaid_sync_jobs.status = 'running' THEN 'running' ELSE 'queued' END,
               next_attempt_at = CASE WHEN plaid_sync_jobs.status = 'running'
                 THEN plaid_sync_jobs.next_attempt_at ELSE EXCLUDED.next_attempt_at END,
               last_error = NULL, updated_at = now()`,
        [randomUUID(), itemId, userId, now],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresTxnRegistry implements TxnRegistry {
  constructor(private readonly pool: pg.Pool) {}

  async has(userId: string, txnId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM plaid_txn_registry WHERE user_id = $1 AND txn_id = $2`,
      [userId, txnId],
    );
    return res.rowCount === 1;
  }

  async add(userId: string, txnId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO plaid_txn_registry (user_id, txn_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, txnId],
    );
  }

  async aliasFor(userId: string, plaidId: string): Promise<string | undefined> {
    const res = await this.pool.query(
      `SELECT canonical_id FROM plaid_txn_aliases WHERE user_id = $1 AND plaid_id = $2`,
      [userId, plaidId],
    );
    return res.rows[0]?.canonical_id;
  }

  async addAlias(userId: string, plaidId: string, canonicalId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO plaid_txn_aliases (user_id, plaid_id, canonical_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, plaid_id) DO UPDATE SET canonical_id = $3`,
      [userId, plaidId, canonicalId],
    );
  }
}

/** ADR-004 boundary: cursor, financial events, and identity links commit as
 * one Postgres transaction after the full external update has been fetched. */
export class PostgresPlaidIngestionStore implements PlaidIngestionStore {
  constructor(private readonly pool: pg.Pool) {}

  async knownTxnIds(userId: string, txnIds: readonly string[]): Promise<Set<string>> {
    if (txnIds.length === 0) return new Set();
    const res = await this.pool.query<{ txn_id: string }>(
      `SELECT txn_id FROM plaid_txn_registry
       WHERE user_id = $1 AND txn_id = ANY($2::text[])`,
      [userId, [...new Set(txnIds)]],
    );
    return new Set(res.rows.map((row) => row.txn_id));
  }

  async aliasesFor(userId: string, plaidIds: readonly string[]): Promise<Map<string, string>> {
    if (plaidIds.length === 0) return new Map();
    const res = await this.pool.query<{ plaid_id: string; canonical_id: string }>(
      `SELECT plaid_id, canonical_id FROM plaid_txn_aliases
       WHERE user_id = $1 AND plaid_id = ANY($2::text[])`,
      [userId, [...new Set(plaidIds)]],
    );
    return new Map(res.rows.map((row) => [row.plaid_id, row.canonical_id]));
  }

  async commit(input: PlaidIngestionCommit): Promise<PlaidIngestionCommitResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Lock order is item first, then user sequence; every Plaid ingestion
      // path uses this method, preventing refresh/webhook deadlocks.
      const item = await client.query<{ user_id: string; cursor: string; status: PlaidConnectionStatus }>(
        `SELECT user_id, cursor, status FROM plaid_items WHERE item_id = $1 FOR UPDATE`,
        [input.itemId],
      );
      const stored = item.rows[0];
      if (!stored || stored.user_id !== input.userId) {
        throw new Error(`unknown plaid item ${input.itemId}`);
      }
      if (stored.status === "disconnecting" || stored.status === "disconnected") throw new Error("Bank disconnected during import");
      if (stored.cursor !== input.expectedCursor) {
        await client.query("ROLLBACK");
        return { committed: false, appended: 0 };
      }

      await client.query(
        `INSERT INTO user_sequences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [input.userId],
      );
      const seqRes = await client.query<{ last_sequence: string }>(
        `SELECT last_sequence FROM user_sequences WHERE user_id = $1 FOR UPDATE`,
        [input.userId],
      );
      let sequence = Number(seqRes.rows[0]!.last_sequence);
      // The user-sequence lock makes this dedupe snapshot stable. Filter
      // first, then bulk insert, so skipped producer retries never burn a
      // sequence and a 50k update does not require 50k database round trips.
      const uniqueEvents = [
        ...new Map(input.events.map((event) => [event.idempotencyKey, event])).values(),
      ];
      let newEvents = uniqueEvents;
      if (uniqueEvents.length > 0) {
        const existing = await client.query<{ idempotency_key: string }>(
          `SELECT idempotency_key FROM events
           WHERE user_id = $1 AND idempotency_key = ANY($2::text[])`,
          [input.userId, uniqueEvents.map((event) => event.idempotencyKey)],
        );
        const existingKeys = new Set(existing.rows.map((row) => row.idempotency_key));
        newEvents = uniqueEvents.filter((event) => !existingKeys.has(event.idempotencyKey));
      }
      const eventRows = newEvents.map((event, index) => ({
        sequence: sequence + index + 1,
        event_id: event.eventId,
        type: event.type,
        schema_version: event.schemaVersion,
        occurred_at: event.occurredAt,
        source: event.source,
        idempotency_key: event.idempotencyKey,
        payload: event.payload,
      }));
      if (eventRows.length > 0) {
        await client.query(
          `INSERT INTO events
             (user_id, sequence, event_id, type, schema_version, occurred_at, source, idempotency_key, payload)
           SELECT $1, row.sequence, row.event_id, row.type, row.schema_version,
                  row.occurred_at, row.source, row.idempotency_key, row.payload
           FROM jsonb_to_recordset($2::jsonb) AS row(
             sequence bigint,
             event_id text,
             type text,
             schema_version int,
             occurred_at timestamptz,
             source text,
             idempotency_key text,
             payload jsonb
           )`,
          [input.userId, JSON.stringify(eventRows)],
        );
      }
      const appended = eventRows.length;
      sequence += appended;

      if (input.knownTxnIds.length > 0) {
        await client.query(
          `INSERT INTO plaid_txn_registry (user_id, txn_id)
           SELECT $1, id FROM unnest($2::text[]) AS id
           ON CONFLICT DO NOTHING`,
          [input.userId, [...new Set(input.knownTxnIds)]],
        );
      }
      if (input.aliases.length > 0) {
        const unique = new Map(input.aliases.map((alias) => [alias.plaidId, alias.canonicalId]));
        await client.query(
          `INSERT INTO plaid_txn_aliases (user_id, plaid_id, canonical_id)
           SELECT $1, plaid_id, canonical_id
           FROM unnest($2::text[], $3::text[]) AS links(plaid_id, canonical_id)
           ON CONFLICT (user_id, plaid_id) DO UPDATE SET canonical_id = EXCLUDED.canonical_id`,
          [input.userId, [...unique.keys()], [...unique.values()]],
        );
      }

      await client.query(
        `UPDATE user_sequences SET last_sequence = $2 WHERE user_id = $1`,
        [input.userId, sequence],
      );
      await client.query(
        `UPDATE plaid_items SET cursor = $2 WHERE item_id = $1`,
        [input.itemId, input.nextCursor],
      );
      await client.query("COMMIT");
      return { committed: true, appended };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
