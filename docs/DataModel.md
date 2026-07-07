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
type ("checking" | "savings" | "credit" | "loan" | "investment" | "cash")
name, mask, currency
balance_current_minor, balance_available_minor?   // as reported by source
balance_as_of (UTC)                               // freshness anchor for verification
status ("active" | "disconnected" | "closed")
```

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

### Bucket vs Goal vs Bill vs Subscription (the noun resolution)

- **Bucket** — a named allocation of *available cash right now* (envelope). `bucket_id, name, allocated_minor, target_minor?`. Buckets partition available cash; the sum of allocations can never exceed available cash (enforced by the state engine).
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
