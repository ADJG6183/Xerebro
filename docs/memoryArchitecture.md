# Memory Architecture

Three stores with strictly separated roles. SQL is truth; memory is context; cache is an optimization. Nothing in vector memory or the cache may feed a financial calculation.

## SQL (truth)

Event log + projections: transactions, balances, accounts, goals, buckets, bills, recommendation audit records. Defined in DataModel.md. The only store engines compute from.

## Vector memory (context) — deferred past v1 (V1Scope.md)

Stores: preferences, past-decision summaries, weekly summaries, voice transcripts, behavior patterns. Backend-side (ADR-001), encrypted, deletable per SecurityPrivacy.md.

Contract (binding when built):

- Retrieval results go to the LLM **explanation** stage only — never to the Decision or State engines.
- Every retrieval result set used in a recommendation is recorded in the audit record (reconstructability).
- Memory writes are events (`InsightGenerated`, `VoiceFactConfirmed`) so memory content is auditable like everything else.

## Semantic cache (optimization) — deferred past v1, rules recorded now

The cache exists to avoid re-paying LLM latency for repeated questions. Binding rules for when it's built:

- **Cache explanations only — never decisions.** The Decision and Verification engines always run; a cache hit can only skip the LLM call. A stale cached "yes, buy it" is architecturally impossible because "yes" never comes from the cache.
- Key: `(intent, extracted_amount_bucket, scoped_state_fields_hash)` — the state hash covers only the fields the fired rules read (the `inputs_snapshot`), not global state, so unrelated transactions don't nuke the cache and related ones correctly do.
- Embedding similarity alone is never sufficient for a hit: extracted amounts must match exactly after normalization (the $600 vs $6,000 problem).
- Entries carry `rules_version`/`params_version` and are invalidated on either changing.
