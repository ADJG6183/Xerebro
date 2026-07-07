# ADR-003: Event Semantics — Immutable Log + SQL Projection

## Status

Accepted — 2026-07-06 (Aaron Green, Chief Architect)

## Context

The previous EventArchitecture.md said "everything is an event", "every event is immutable", and "state never directly creates events" — without deciding whether events are the *source of truth* (event sourcing) or *notifications* (event-driven). It also contradicted the "transactions are immutable" invariant (aggregators modify and remove transactions) and forbade the only mechanism that could emit flagship derived events like `GoalCompleted`.

## Decision

**Event-driven with an immutable audit log — not full event sourcing.**

- The **event log is append-only and immutable**. That is the precise form of the old "transactions are immutable" invariant.
- The **SQL projection is what engines read** and is mutable: it is rebuilt/folded from the log. Rebuilding the projection from the log must always be possible (this is the repair path for drift).
- **User annotations** (category corrections, notes, renames) live in an overlay table keyed by canonical transaction id; they survive upstream `TransactionUpdated` events.

### Event envelope

```
{
  event_id:      uuid            // producer-generated
  sequence:      bigint          // server-assigned, gapless per user; THE global order
  type:          string          // e.g. "TransactionPosted"
  schema_version: int            // per-type; consumers must handle n and n-1
  occurred_at:   timestamp (UTC)
  source:        "plaid" | "user" | "system" | "detector"
  idempotency_key: string
  payload:       object
}
```

### Catalog changes

- **Added: `TransactionRemoved`** (pending holds that never post, aggregator deletions). Plaid `transactions/sync` maps directly: added → `TransactionPosted`, modified → `TransactionUpdated`, removed → `TransactionRemoved`.
- Pending→posted identity: the ACL links Plaid's `pending_transaction_id` so a posting emits `TransactionUpdated` (status change) on the same canonical transaction, never a duplicate.

### Idempotency

Plaid webhooks are notifications-to-fetch, not payloads. Idempotency is therefore keyed on **(item_id, sync cursor)** for aggregator ingestion — never on webhook delivery id. User/system events carry producer idempotency keys; the server dedupes on them.

### Derived events (replaces "state never directly creates events")

State-change **detectors** are explicit, named components that watch projection changes and emit events (`GoalCompleted`, `OverspendingDetected`, `LowBalanceProjected`). Rules:

- A detector may only read the projection and emit events; it never writes state directly.
- Detector emissions carry `source: "detector"` and the input state version, so every derived event is auditable.
- Detectors must be idempotent per state version (re-running on the same state emits nothing new).

## Alternatives

- **Full event sourcing** (projection never authoritative, everything folds at read time): maximal auditability, but heavy on mobile, awkward with aggregator rewrites, and overkill for v1. Rejected for now; the append-only log preserves the option.
- **Mutable rows + audit table**: simplest, but forfeits replay/rebuild — which we specifically need as the reconciliation repair path. Rejected.

## Consequences

- "Immutable" now has a precise referent (the log), and the old contradiction with `TransactionUpdated` disappears.
- Projection rebuild-from-log is the universal repair tool (drift, corruption, migration).
- Schema evolution is explicit: bumping `schema_version` requires a consumer-compatibility note in the PR.

## Tradeoffs

Two representations (log + projection) must be kept consistent; we pay that with fold determinism tests in the shared engines package. Accepted — it is exactly the auditability the product's trust promise requires.

## References

- ADR-001, DataModel.md, verificationEngine.md, EventArchitecture.md
