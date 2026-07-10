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
 * Schema bootstrap is CREATE TABLE IF NOT EXISTS on startup — honest v1
 * shortcut; a real migration tool arrives when the schema starts moving.
 */
import pg from "pg";
import type { EventEnvelope } from "@xerebro/engines";
import type { AppendResult, EventStore, UnsequencedEvent } from "../eventStore";
import type { ItemStore, PlaidItem, TxnRegistry } from "../plaid/stores";

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
      cursor text NOT NULL DEFAULT ''
    );
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

export class PostgresItemStore implements ItemStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(itemId: string): Promise<PlaidItem | undefined> {
    const res = await this.pool.query(
      `SELECT item_id, user_id, access_token_ref, cursor FROM plaid_items WHERE item_id = $1`,
      [itemId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      itemId: row.item_id,
      userId: row.user_id,
      accessTokenRef: row.access_token_ref,
      cursor: row.cursor,
    };
  }

  async put(item: PlaidItem): Promise<void> {
    await this.pool.query(
      `INSERT INTO plaid_items (item_id, user_id, access_token_ref, cursor)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (item_id) DO UPDATE
         SET user_id = $2, access_token_ref = $3, cursor = $4`,
      [item.itemId, item.userId, item.accessTokenRef, item.cursor],
    );
  }

  async setCursor(itemId: string, cursor: string): Promise<void> {
    const res = await this.pool.query(`UPDATE plaid_items SET cursor = $2 WHERE item_id = $1`, [
      itemId,
      cursor,
    ]);
    if (res.rowCount === 0) throw new Error(`unknown plaid item ${itemId}`);
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
