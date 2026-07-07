# Financial State Engine

Purpose: maintain the canonical derived financial state for every user. Pure module in the shared engines package (ADR-002); runs on-device against the local projection (ADR-001).

## Inputs

Projections and effective values only (DataModel.md): accounts, transactions (with annotation overlays applied), goals, buckets, liabilities + payoff plans, bills/subscriptions, pay schedules, manual adjustments (which are events like everything else).

Voice-derived facts are **not** an input until a user has confirmed them, at which point they arrive as ordinary user events (`VoiceFactConfirmed`, post-v1) — see AIArchitecture.md. Probabilistic output never enters this engine.

## Outputs

Available cash (balance minus pending outflows minus bucket allocations), net worth, savings rate, debt ratio, credit utilization, goal progress, upcoming obligations (timezone-correct local dates, DataModel.md), liquidity. Financial Health Score is deferred until specified (V1Scope.md).

Every output carries the `sequence` of the last event included and the underlying `balance_as_of` — data age is knowable for everything downstream (SystemInvariants.md).

## Responsibilities

- Compute all derived metrics deterministically (property-tested; integer minor units only).
- Recompute incrementally on each applied event; full recompute must equal incremental (tested).
- Enforce: bucket allocations never exceed available cash.
- Provide read-only state to the Decision and Verification engines.
- Never generate recommendations. Never communicate with the user. No network access.
