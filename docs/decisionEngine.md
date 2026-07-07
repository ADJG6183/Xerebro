# Decision Engine

Purpose: generate deterministic financial decisions. Pure TypeScript module in the shared engines package (ADR-002); runs on-device (ADR-001). No AI reasoning, no natural language, no LLM-delegated calculation — the LLM explains this engine's output, never produces it.

## Responsibilities

Purchase approval (v1) · Debt recommendations · Bucket allocation · Savings recommendations · Goal prioritization · Spending alerts (post-v1; see V1Scope.md)

## Inputs (all versioned, all snapshotted)

- **Financial State** — read-only view from the Financial State Engine (effective values, incl. annotation overlays).
- **Rules** — `rules_version`: the deterministic rule set. Rules ship as reviewed, tested code with defaults; user-visible settings (e.g., bucket priorities) are rule *inputs*, not rule mutations.
- **Parameters** — `params_version`: the bounded learned-parameter set (see Learning below).
- **Declared required inputs** — each rule family declares the state fields it needs; verification scores completeness against this declaration (verificationEngine.md).

## Outputs

`{ decision, risk_score, tradeoffs[], required_conditions[], rules_fired[], inputs_snapshot }`

The full output plus `rules_version` and `params_version` is written to the recommendation audit record (DataModel.md) before the LLM ever sees it.

## Determinism contract

Same `inputs_snapshot` + same `rules_version` + same `params_version` → byte-identical output, forever. This is enforced by property tests in the engines package and is what makes recommendations reconstructable (SystemInvariants.md).

## Learning: two lanes (how "feedback improves" coexists with determinism)

**Lane 1 — automatic, never decision-affecting.** Feedback may auto-tune presentation parameters only: explanation tone, insight ranking, nudge cadence. Hard-bounded ranges, versioned as part of `params_version`. A Lane 1 change can never alter `decision`.

**Lane 2 — propose-and-approve, decision-affecting.** Anything that would change a financial decision (risk thresholds, savings targets, rule weights) is only ever **proposed** to the user — "You've skipped 5 savings nudges; lower the auto-save target from $500 to $400?" — and applied on explicit approval, producing a new `params_version` with an audit entry of who/what/when/why.

Guards: Lane 2 proposals are rate-limited (max one per rule family per week) and bounded (a proposal can never move a parameter past documented floors — e.g., the system may never propose reducing emergency-fund contribution to zero). This prevents degenerate loops where ignoring nudges teaches the product to stop protecting the user.

## Constraints

- No AI reasoning; no natural language in, none out.
- No network access; the engine is a pure function of its inputs.
- Every decision is class-tagged (`read_only` | `high_stakes`) for verification (verificationEngine.md).
- Out of regulatory scope: investment/retirement/tax allocation (SecurityPrivacy.md) — the engine has no rule families there, by design.
