# Verification Engine

Purpose: prevent incorrect recommendations from reaching the user, and label everything else with its data quality. Runs on-device (ADR-001) as part of the shared engines package (ADR-002).

## Decision classes

Verification is **tiered by stakes**. Every request carries a `decision_class`:

| Class | Examples | Policy |
|---|---|---|
| `read_only` | Dashboard metrics, spending summaries, insights | May render from stale data **with a visible freshness label** ("as of 14h ago"). |
| `high_stakes` | Purchase approval, debt payoff guidance, anything advising money movement | Requires full verification. On failure: **"can't verify right now" + what's needed + the cached picture, clearly labeled**. Never an unlabeled estimate. |

## Freshness: refresh-race (high-stakes class)

1. If the account's `balance_as_of` is within the class freshness window (**purchases: 12 hours**, configurable per decision type), answer immediately from local state. Target ≤1 s.
2. Otherwise, fire a live balance refresh through the backend with a **3-second timeout**.
   - Refresh succeeds → verify and answer on fresh data.
   - Timeout / aggregator down / offline → return `CANT_VERIFY` with the reason, the data age, and the cached picture labeled as such.
3. Every answer, in every class, displays data age. There is no unlabeled data in Xerebro.

`read_only` freshness: label thresholds at 24h ("as of yesterday") and 72h (prominent stale warning + reconnect prompt).

## Confidence — defined

Confidence is a **data-quality score computed by verification**, not a model probability:

```
confidence = min(freshness_score, completeness_score, reconciliation_score)  ∈ [0, 1]
freshness_score:      1.0 within window, linear decay to 0 at 4× window
completeness_score:   fraction of required inputs present for the rules that fired
reconciliation_score: 1.0 within drift tolerance; 0.5 minor drift; 0 unresolved drift
```

High-stakes threshold: confidence ≥ 0.8 to answer as *verified*. The score, and which component bounded it, are stored on the recommendation record (DataModel.md). The Decision Engine does not compute confidence; it declares its required inputs and verification scores them (this replaces the old undefined "Confidence Request").

## Checks

- **Freshness** — as above.
- **Required inputs** — the rule set declares its inputs; missing input → `NEEDS_USER_INPUT` naming the field.
- **Duplicate detection** — same account, amount, and date-window with distinct canonical ids → flag, exclude from state, queue for review.
- **Pending vs posted** — pending amounts count against available cash; a pending txn never double-counts once its linked posted txn arrives (identity link, ADR-003).
- **Balance reconciliation** — ledger-computed balance vs source-reported balance:
  - Tolerance band: within **max($5, 1%)** → reconciled.
  - Minor drift (≤ $25): reconciled with reduced score; background task investigates (usually a missing pending).
  - Beyond that: `RECONCILIATION_FAILED` → **repair path**: full projection rebuild from the event log (ADR-003), then fresh aggregator snapshot resync. If drift persists post-repair, surface to the user with a one-tap "resync accounts" — verification failure must never silently disable recommendations (no zombie accounts).
- **Rule validation** — rules version on device matches the version verification expects; mismatch → block and force rules sync.

## Outputs

`VERIFIED` | `CANT_VERIFY (reason, data_age)` | `NEEDS_USER_INPUT (fields)` | `STALE_LABELED` (read_only class only)

Every output is written to the recommendation audit record before anything renders.

## Failure modes & fallbacks (per Reliability.md contract)

| Failure | Behavior | Timeout | Retry |
|---|---|---|---|
| Aggregator refresh fails | `CANT_VERIFY` + cached labeled picture | 3 s | Background retry with backoff; push when verified answer available (opt-in) |
| Reconciliation fails | Rebuild-from-log → snapshot resync → user-visible repair prompt | — | Once per sync cycle |
| Rules version mismatch | Block high-stakes; read_only continues labeled | — | Immediate rules sync |
| Device offline | High-stakes → `CANT_VERIFY (offline)`; read_only → labeled stale | — | On reconnect |
