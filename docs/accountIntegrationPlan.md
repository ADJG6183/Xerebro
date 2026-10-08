# Account integration implementation plan

Status: in progress. Stages 1 and 2 are complete. Stage 3's approved safety
policy is implemented and recorded in ADR-005; establishing durable balance
reconciliation checkpoints remains. Stage 4 includes the Accounts view, durable
connection lifecycle (ADR-006), and approved reconnection-history continuity
(ADR-007). Native/Sandbox release checks remain; stage 5 advance-entry matching
and transfer/bill integration are separate remaining work.

## Goal and verified baseline

Give users one understandable account list and one consistent financial picture, including bank imports, manual accounts, offline edits, bills, and advance purchase entries.

Rechecked against commit `52c3ce8`. Re-ran the three review reproductions: queued expenses are omitted from purchase checks; pending-to-posted transitions split across pages disappear; absent available balance ignores pending outflows. Prior full suite: 212 passing tests, 15 Postgres tests skipped. Typecheck remains unverified. No production changes are included in this plan.

Already decided: allow advance entries on connected accounts, with matching to subsequent bank transactions.

## Delivery order

Each stage is a separately reviewable change: write failing behavior tests, implement, run targeted checks, then demonstrate the result. Keep engines deterministic, money in integer minor units, and financial history append-only.

### 1. Establish regression tests and consistent local state

- Turn the three temporary reproductions into permanent regression tests.
- Make dashboard and purchase checks use a shared snapshot containing committed events and unsynced user actions. Record committed sequence and contributing pending action IDs in the audit; provisional sequence numbers never become server order.
- Audit outbox acknowledgement: retain pending actions until their server-sequenced copies are stored locally, so a successful upload followed by a failed download cannot make an expense temporarily disappear. Serialize concurrent flushes.
- Persist recommendation records locally before rendering; do not wait for upload or ordinary delta download on a fresh-data decision path.
- Give each new edit its own stable action ID. Retries reuse that ID; editing an account again or changing a bucket back to a previous value must remain a new action.
- Use actual local calendar dates for bills and reporting, rather than slicing a UTC timestamp.

Primary files: app data `decisionFlow`, `projectionCache`, `syncClient`, `userEvents`, and `App.tsx`.

Acceptance: $1,000 minus an $800 queued expense cannot approve a $400 purchase; queued bills/buckets affect the verdict; failed downloads, repeat edits, restarts, and retries preserve the same balances without duplication.

### 2. Make bank imports atomic and recoverable

- Collect and validate one complete paginated update before resolving pending/posting identities. Preserve genuine removals; apply modified dates/status as well as amounts and merchant fields.
- Normalize with maps/sets across the complete update. Batch registry lookups instead of issuing a database query per transaction.
- Introduce one store operation that commits normalized events, transaction aliases, and the final cursor together. Fetch bank data outside the database transaction; at commit, check that the starting cursor still matches. If another worker advanced it, discard/refetch the stale work.
- Retain the existing per-user sequence lock, with consistent lock ordering. Handle a non-advancing cursor, page limit, and pagination mutation as explicit incomplete/retry outcomes, never successful partial imports.
- Do not mark an unchanged empty cursor as permanently processed: later data at that cursor must remain importable.
- Validate upstream payloads before cursor advancement; malformed data must not silently become empty successful imports.

Primary files: server `plaid/acl.ts`, `plaid/httpGateway.ts`, `plaid/stores.ts`, `eventStore.ts`, `persistence/postgres.ts`.

Acceptance: both page orderings of pending/posting, replay, concurrent webhook/refresh, mid-import restart, unchanged empty cursor followed by data, and forced rollback produce one complete, reproducible result. Run these against real test Postgres as well as memory stores.

Decision gate: approved 2026-09-05 (ADR-004). Avoid holding database locks during Plaid network requests.

### 3. Make verification reflect what is actually known

- Distinguish reported current balance, reported available balance, and locally adjusted spending capacity.
- Define fallback treatment of pending outflows when available balance is absent. Do not spend pending inflows or classify unknown account types as spendable cash. Reject unsupported currencies from USD aggregates explicitly.
- Replace hardcoded zero drift with per-account reconciliation results and an explicit unknown state. Establish a trustworthy opening checkpoint and history coverage; never claim reconciliation by adding incomplete history or comparing a balance to itself.
- Track balance freshness separately from transaction-import progress. Enforce refresh failure and required-input rules even when computed totals default to zero.
- Treat overallocated buckets as a visible condition; distinguish rejecting an excessive new allocation from existing allocations becoming excessive after a bank balance drops.
- Rebuild projections for projection faults; use upstream resync and append-only corrections for wrong or missing imported facts. Replaying a flawed log alone cannot repair it.

Primary files: engines `state/financialState.ts`, `verification/confidence.ts`; app `decisionFlow.ts`; server `plaid/balances.ts`.

Acceptance: unknown balances, missing history, drift, stale refresh failure, unsupported currency, and excess allocations cannot receive unjustified verification. Manual-only data keeps its documented treatment and label.

Decision gate: approved 2026-09-05 (ADR-005): show uncertain cached totals with reasons and withhold verified approval until the required evidence exists.

### 4. Add account visibility and connection recovery

Progress: the offline Accounts tab, bank/manual grouping, masks, balance basis,
age, transaction counts, device-write restrictions, durable jobs, restart-safe
Link ownership, lifecycle status, and disconnect are implemented (ADR-006).
Plaid update-mode reconnect remains a separate product decision.

Approved reconnection-history continuity is implemented in ADR-007: explicit
previous-account confirmation, complete-sync handoff evidence, visible excluded
overlap, exact user-confirmed transaction matches, separate/undo actions, and
shared warnings across dashboard, copilot, and purchase verification. This covers
new links after disconnect, not update-mode sign-in repair or advance-entry matching.
Existing saved history is retained; no automatic legacy duplicate repair is run.

- Add a local Accounts view listing manual accounts and bank accounts grouped by connection, with type, supported identifying metadata, balance age, and transaction details.
- Preserve institution/account identifiers and display masks where supplied. Keep user names/preferences in an overlay so bank updates cannot overwrite them.
- Track connecting, importing, ready, retry-needed, reauthentication-needed, and disconnected states durably. Token exchange success and completed financial import are separate milestones.
- Make completion retry-safe, retain session ownership across restarts, and unify redirect/hosted completion handling. Enforce user and account ownership on every management operation and restrict device writes to their allowed event types/fields.
- Offer bounded refresh, retry import, reconnect through the existing connection, and explicit disconnect. Resume ingestion from durable work after a crash; a Postgres-backed job table is the proposed starting point, not an additional queue service.
- Read account lists from local projections; network work updates them in the background. Read Expo 54 guidance before app implementation and test on the supported native build.

Acceptance: an interrupted import retries without linking twice; restart preserves progress; one user's requests cannot alter another user's accounts; missing consent/reauthentication is visible; account details work offline.

Decision gate: approved 2026-09-12 (ADR-006). Reconnect/update-mode behavior is intentionally deferred because `/item/remove` makes a disconnected Item permanent; a later reconnection creates a new Item and needs explicit account-history identity rules.

### 5. Match advance entries, transfers, bills, and duplicate accounts

- Store advance entries independently from bank facts, with explicit proposed/confirmed/rejected/reversed match events. Preserve notes and history; do not delete either source record.
- Derive one effective transaction for spending. Separately determine whether its cash impact is already reflected in the bank balance: matching identity alone does not prove balance coverage. Ambiguous balance coverage remains labeled and cannot silently receive verified approval.
- Generate candidates using account, currency, date window, amount, and merchant evidence. Start with exact supported cases and user confirmation; tips, split payments, refunds, and multiple plausible matches remain unresolved until handled explicitly.
- Store one-to-one match constraints transactionally; repeat syncs and multiple devices cannot match the same entry twice. Support reversing an incorrect match.
- Represent transfers as linked movements: maintain account balances while excluding internal transfers from income/spending. Handle credit-card payments without counting the original purchase again.
- Model bill occurrences, paid/part-paid state, and cadence so a payment settles the appropriate occurrence without hiding overdue obligations or future recurrences.
- When a bank account may replace a manual account, present a preview and require confirmation. Choose a transition date and treatment of overlapping entries; do not merge by name or last four digits alone.

Primary files: shared event schemas/folds/queries; server matching/validation; app account, transaction, bill, and purchase models.

Acceptance: advance entry then pending then posted counts once; changed amounts preserve notes; ambiguous/reversed matches are recoverable; transfers, bill payments, and confirmed manual-to-bank transitions do not duplicate money. Dashboard and copilot use the same classification rules; server-only chat must disclose unsynced device changes it cannot see.

Decision gate: Aaron already approved advance entries with matching. Still approve automatic-match thresholds, partial/split matching scope, and manual-account transition rules before implementing those policies.

## Efficiency and release checks

- Target one transaction scan plus one account scan for balances: O(T + A), instead of rescanning all T transactions for each of A accounts.
- Import normalization targets O(N) expected map/set work and bounded batch database calls. Cap/stage unusually large updates rather than retaining unlimited pages in memory.
- Matching searches indexed account/currency/date/amount candidates, not every transaction against every other transaction. Cost depends on the candidate count; measure dense same-amount cases rather than promise constant time.
- Add indexed device reads after a sequence; the current cache still calls `all()`. Existing immutable folds also copy maps, so measure those costs before claiming fully incremental performance. Preserve replay equivalence if batch folding is optimized.
- Test representative small and large histories, including 10,000 and 50,000 transactions. Measure existing p90 goals on supported native hardware: cached dashboard <=500 ms, fresh decision <=1 s, refresh-race <=4 s. Desktop unit tests do not establish these budgets.
- Before release: complete typecheck, all unit/integration tests, actual Postgres concurrency/migration tests, and a controlled Plaid Sandbox/native walkthrough. Mark skipped checks explicitly. Verify additive upgrades with old event schemas and preserve historical audit records; backfill corrections only through a reviewed repair plan.
- Use feature flags for account management and matching until their migrations and tests pass. Disabling a feature must not make already-created financial adjustments disappear.

## How decisions will be brought to Aaron

For each material gate, present the recommended behavior, one concrete user example, alternatives, and the effect on existing data. Record an approved ADR where required by CLAUDE.md. Routine implementation proceeds within approved scope; unresolved choices block only their dependent work.
