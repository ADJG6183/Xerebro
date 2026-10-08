# Data Model

Canonical schema for Xerebro. The server Postgres holds the event log and canonical projections; device SQLite holds a synced replica of the projections (ADR-001). All engines read the projection, never the log directly.

## Conventions

- **Money is always integer minor units** (`amount_minor: bigint`) plus an ISO 4217 `currency` code. No floats, anywhere, ever. v1 is single-currency (USD); `currency` exists so multi-currency is a data migration, not a redesign.
- **Timestamps are UTC.** Calendar concepts (due dates, "this month") are **local dates** (no time component) evaluated in the user's profile timezone. A bill is never "overdue" because of UTC midnight.
- Every projection row carries `updated_at` and the `sequence` of the last event that touched it.

## Entities

### Account

```
account_id, user_id, source ("plaid" | "manual"), plaid_item_id?, plaid_account_id?
type ("checking" | "savings" | "credit" | "loan" | "investment" | "cash" | "unknown")
name, mask, currency
balance_current_minor, balance_available_minor?   // as reported by source
balance_current_known, reconciliation_status, reconciliation_drift_minor?
balance_basis ("available" | "current_minus_pending" | "excluded")  // which ADR-005 rule produced the USD spending-capacity figure
balance_as_of (UTC)                               // freshness anchor for verification
status ("active" | "disconnected" | "closed")
```

Plaid connection lifecycle is durable server metadata rather than user-writable
financial evidence. `plaid_items.status` is one of `importing`, `ready`,
`retry_needed`, `reauthentication_needed`, `disconnecting`, or `disconnected`.
`plaid_sync_jobs` records one leased `sync` or `disconnect` job per Item with
attempt count, next-attempt time, and a safe error label (ADR-006). Link-token
ownership is stored only as an expiring hash.

`Account.status` and `plaid_items.status` answer different questions and are
never collapsed into one enum: `Account.status` is the account's own lifecycle
(active while usable, disconnected once its item is gone, closed if the
institution closes it); `plaid_items.status` is connection health. An account
stays `active` while its item moves through `retry_needed` or
`reauthentication_needed` — a shaky connection does not make the account
non-existent — and only becomes `disconnected` when its item reaches
`disconnected`. Verification reads `plaid_items.status` and `balance_as_of`
for staleness; it never reads `Account.status` for that.

Debt is not a separate entity: a **liability is an account** (`credit` | `loan`) plus an optional `PayoffPlan { account_id, strategy, target_date?, min_payment_minor }`.

### Transaction (projection) + annotation overlay

```
Transaction:
  txn_id (canonical), account_id
  amount_minor (signed: negative = outflow), currency
  status ("pending" | "posted"), posted_date (local), authorized_date? (local)
  merchant_raw, merchant_normalized?, category_source ("plaid" | "model" | "user")
  category, pending_txn_id?     // identity link used at pending→posted (ADR-003)
  removed (bool)                // tombstone set by TransactionRemoved; folds keep it for audit

TransactionAnnotation:          // user layer; survives upstream updates
  txn_id, category_override?, note?, renamed_merchant?, updated_at
```

Effective category = `annotation.category_override ?? transaction.category`. Engines must read effective values.

### Reconnection history overlays (ADR-007)

`AccountContinuitySet` carries `accountId`, candidate predecessor IDs and optional
`lastSyncedAt`, `decision` (`pending|same|different`), and for continuity a
`predecessorId` with optional inclusive local `cutoffDate`. Every decision has its
event sequence as its version; reopening appends a new pending decision.

`TransactionOverlapReviewed` carries `txnId`, `decision` (`duplicate|unique|reopen`),
bank-fact `signature`, `continuitySequence`, and for a duplicate `originalTxnId`
and `originalSignature`. The projection revalidates signatures and one-to-one
claims. Invalidated reviews exclude the replacement record until reviewed again.
All raw transactions and annotations remain available for display/audit.

`BankSyncCompleted { itemId, completedAt }` records successful complete balance and
transaction import, independently of balance freshness. Older connections without
this evidence have an unknown handoff, never an inferred successful checkpoint.
This event establishes *continuity* evidence (ADR-007) only — a gapless import
handoff. It is **not** the "opening checkpoint" ADR-005/SystemInvariants.md
require for reconciliation: reconciliation needs an independently-observed bank
balance to compare the replayed ledger against, and `BankSyncCompleted` is a
completeness marker from the same sync, not a second, independent observation.
Comparing the ledger to the balance that produced it is comparing a number to
itself. The actual reconciliation-evidence source remains an open decision
(rocketMoneyMvpSpec.md §7, §12).

User decisions include their normalized command for idempotent retry validation.
Only authenticated server review commands emit user decision events; these types
are not accepted through the generic device event-upload API.

### Bucket vs Goal vs Bill vs Subscription (the noun resolution)

- **Bucket** — a named allocation of *available cash right now* (envelope). `bucket_id, name, allocated_minor, target_minor?`. New over-allocation is rejected at the command boundary; if a later balance drop makes existing allocations excessive, the state engine reports that condition without rewriting history.
- **Goal** — a *future target*: `goal_id, name, target_minor, target_date?, funded_by_bucket_id?, status`. A goal is aspiration + progress; a bucket is present-tense money. The emergency fund is a **bucket** with a target (i.e., also visible as a goal via `funded_by_bucket_id`).
- **Bill** — an *expected recurring obligation*: `bill_id, name, expected_amount_minor, cadence, next_due (local date), autopay?, matched_account_id?, matcher (merchant pattern)`. Bills are predictions matched against transactions.
- **Subscription** — a Bill with `kind: "subscription"` (cancellable service). Not a separate table; a flag. This kills the double-count risk by construction: one obligation, one row.

### Paycheck

A paycheck is an *income transaction matched to a `PaySchedule`*: `pay_schedule_id, employer_pattern, expected_amount_minor, cadence, next_expected (local date)`. Matching emits `PaycheckReceived` (detector, ADR-003). No duplicate money object.

### Recommendation audit record

Every recommendation shown to the user stores, verbatim, everything needed to reconstruct it **without re-running anything**:

```
recommendation_id, user_id, created_at
decision_class ("read_only" | "high_stakes")        // verificationEngine.md
inputs_snapshot (json)          // exact financial-state fields the rules read
rules_version, params_version   // decisionEngine.md two-lane learning
rules_fired (list), decision_output (json)
verification { status, checks_run, data_age_seconds, confidence }
retrieved_memories (list)       // empty in v1; reserved
llm { provider, model, prompt_template_version, explanation_text_verbatim }
user_response? ("accepted" | "ignored" | "modified" | "rejected"), responded_at?
```

Reconstructable means: display this record. Never regenerate the explanation.

### Feedback

`feedback_id, recommendation_id, response, modification (json?), created_at`. v1 logs feedback and acts on none of it (V1Scope.md).

## Deferred (designed-for, not built)

- Joint/shared account ownership model (multi-user) — post-v1; LWW-per-field conflict policy must be revisited with it (ADR-001).
- Multi-currency computation (schema already carries currency codes).
- Vector memory records (memoryArchitecture.md).

## References

ADR-001, ADR-003, verificationEngine.md, decisionEngine.md
