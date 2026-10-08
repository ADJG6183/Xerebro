# System Invariants

These rules are never violated. Each one is stated so it can be checked mechanically — by a test, a type, or a runtime assertion. An invariant that cannot be checked does not belong in this file.

## Financial Correctness

- All money math uses integer minor units (DataModel.md). A float in a money path fails CI.
- Financial calculations are deterministic: same inputs + same `rules_version` + same `params_version` → identical output (property-tested in the engines package).
- No LLM output is ever parsed into a balance, amount, or decision. The LLM's output type is display text only.
- `high_stakes` recommendations require `VERIFIED` status. `read_only` surfaces may render stale data **only** with a visible data-age label. (Class definitions: verificationEngine.md.)
- USD spending capacity excludes unsupported currencies and unknown account types. Missing available balances fall back to current minus pending withdrawals; pending inflows never increase spending capacity (ADR-005).
- A fresh bank balance is not reconciliation proof. Bank-backed high-stakes guidance remains unverified until opening-checkpoint and history coverage establish reconciliation (ADR-005).

## Data Integrity

- **The event log is append-only and immutable.** Projections and annotations are mutable and must always be rebuildable from the log (ADR-003). ("Transactions are immutable" — sharpened: the *log* is.)
- Every transaction has one canonical id; pending→posted transitions update the same canonical transaction via the identity link, never create a duplicate (ADR-003).
- Transaction removal is represented by a `TransactionRemoved` event and a tombstone — never by deleting log entries.
- Aggregator ingestion is idempotent on (item_id, sync cursor); user/system events are idempotent on producer keys.

## User Experience

- After first successful sync, the dashboard always renders from device SQLite without network (≤500 ms). Before first sync, the app shows an explicit first-sync state — this is the one documented exception, not a violation.
- Background sync never blocks interaction.
- Every displayed number carries a knowable data age; nothing renders as fresher than it is.
- Every failure path defined in a component doc names its fallback (Reliability.md contract).

## AI

- AI explains. Rules decide. Verification approves. Memory contextualizes.
- The LLM proxy allowlist (SecurityPrivacy.md) is the only path to a model provider; the client has no provider credentials.
- Voice- or NLU-derived facts enter canonical state only after explicit user confirmation (AIArchitecture.md).

## Trust

- Every recommendation is **reconstructable by retrieval, not regeneration**: the audit record stores the inputs snapshot, `rules_version`, `params_version`, rules fired, verification result (incl. confidence and data age), retrieved memories, prompt template version, and the explanation text **verbatim** (DataModel.md).
- Uncertainty is shown, never hidden: `CANT_VERIFY` and `NEEDS_USER_INPUT` are user-visible states with reasons.
- The user can always see *why*: rules fired and tradeoffs are inspectable on every recommendation.
