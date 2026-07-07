# Event Architecture

Semantics decided in ADR-003: **event-driven with an immutable audit log.** The append-only event log is the auditable record; SQL projections are what engines read; projections must always be rebuildable from the log. This is not full event sourcing.

## Envelope

Every event carries: `event_id`, server-assigned `sequence` (the global order, gapless per user), `type`, `schema_version`, `occurred_at` (UTC), `source` (`plaid` | `user` | `system` | `detector`), `idempotency_key`, `payload`. Consumers must handle schema versions n and n−1.

## Catalog

**Aggregator (via Plaid ACL):** `TransactionPosted` · `TransactionUpdated` · `TransactionRemoved` · `BankConnected` · `BankDisconnected` · `SyncCompleted` · `SyncFailed`

**User:** `BucketCreated` · `BucketUpdated` · `GoalCreated` · `TransactionAnnotated` · `FeedbackSubmitted` · `ManualTransactionEntered` · `VoiceFactConfirmed` (post-v1)

**Detectors (derived from state — see below):** `PaycheckReceived` · `GoalCompleted` · `OverspendingDetected` · `BillDueSoon`

**System:** `InsightGenerated` · `NotificationSent` · `RulesUpdated` · `ParamsUpdated`

## Rules

- The log is append-only; removal is a `TransactionRemoved` event + tombstone, never a deletion.
- Events update projections via deterministic folds (tested in the engines package).
- **Derived events are emitted by named detectors** — explicit components that read projection changes and emit events. A detector never writes state directly, tags `source: "detector"` with the input state version, and is idempotent per state version. (This replaces the old rule "state never directly creates events", which forbade our own flagship events.)
- Idempotency: aggregator ingestion on (item_id, sync cursor); other producers on `idempotency_key`.
- Ordering: the server assigns `sequence` on arrival; devices sync by sequence and never invent global order (ADR-001).

## References

ADR-003 (decision + alternatives), ADR-001 (sync), DataModel.md (payload shapes)
