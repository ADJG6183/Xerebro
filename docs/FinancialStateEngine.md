# Financial State Engine

Purpose: maintain the canonical derived financial state for every user. Pure module in the shared engines package (ADR-002); runs on-device against the local projection (ADR-001).

## Inputs

Projections and effective values only (DataModel.md): accounts, transactions (with annotation overlays applied), goals, buckets, liabilities + payoff plans, bills/subscriptions, pay schedules, manual adjustments (which are events like everything else).

Voice-derived facts are **not** an input until a user has confirmed them, at which point they arrive as ordinary user events (`VoiceFactConfirmed`, post-v1) — see AIArchitecture.md. Probabilistic output never enters this engine.

## Outputs

Available USD cash, the evidence basis used per account, excluded/unknown
accounts, over-allocation, net worth, savings rate, debt ratio, credit
utilization, goal progress, upcoming obligations (timezone-correct local
dates, DataModel.md), and liquidity. Financial Health Score is deferred until
specified (V1Scope.md).

For bank accounts, spending capacity uses reported available balance when
present. Otherwise it uses current balance minus known pending withdrawals;
pending deposits do not increase capacity. Unsupported currencies and unknown
account types are excluded and reported, never silently converted (ADR-005).

Every output carries the `sequence` of the last event included and the underlying `balance_as_of` — data age is knowable for everything downstream (SystemInvariants.md).

## Responsibilities

- Compute all derived metrics deterministically (property-tested; integer minor units only).
- Recompute incrementally on each applied event; full recompute must equal incremental (tested).
- Report when existing bucket allocations exceed known cash. New allocations
  may be rejected at the command boundary, but a later balance drop must not
  make historical allocations disappear.
- Provide read-only state to the Decision and Verification engines.
- Never generate recommendations. Never communicate with the user. No network access.
