# Event Architecture

Semantics decided in ADR-003: **event-driven with an immutable audit log.** The append-only event log is the auditable record; SQL projections are what engines read; projections must always be rebuildable from the log. This is not full event sourcing.

## Envelope

Every event carries: `event_id`, server-assigned `sequence` (the global order, gapless per user), `type`, `schema_version`, `occurred_at` (UTC), `source` (`plaid` | `user` | `system` | `detector`), `idempotency_key`, `payload`. Consumers must handle schema versions n and n−1.

## Catalog

**Aggregator (via Plaid ACL):** `TransactionPosted` · `TransactionUpdated` · `TransactionRemoved` · `BankConnected` · `BankDisconnected` · `SyncCompleted` · `SyncFailed`

**User:** `AccountUpserted` (manual accounts) · `BucketUpserted` · `BillUpserted` · `GoalCreated` · `TransactionAnnotated` · `RecommendationRecorded` · `RecommendationExplanationAdded` · `FeedbackSubmitted` · `VoiceFactConfirmed` (post-v1)

`RecommendationExplanationAdded` is an append-only *amendment*: the audit record ships at verdict time (with the template explanation); when the LLM explanation arrives seconds later and passes the faithfulness check, it is appended under the same `recommendationId` rather than editing the shipped record. Reconstruction = record + its amendments.

Manual transactions are ordinary `TransactionPosted` events with `source: "user"` — one event type per fact, distinguished by provenance, so the fold has a single code path. (`AccountUpserted` with `source: "plaid"` will carry aggregator account metadata/balances when balance sync lands.) Buckets and bills follow the same upsert-style convention as accounts: one event type, last-write-by-sequence wins per id.

**Provenance rule for device uploads:** the server accepts only `source: "user"` from devices — a client may never claim to be the aggregator or a server detector. `RecommendationRecorded` and `FeedbackSubmitted` are classified as user events even though the device's engine assembles them: both exist only because the user asked a question or responded to an answer, and the audit record they carry is the user-facing artifact (DataModel.md). Rationale: a compromised client that could push `source: "system"` events could forge detector output; keeping the device's vocabulary user-only contains that blast radius.

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
