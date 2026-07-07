# CLAUDE.md

You are contributing to Xerebro, a local-first, trust-first financial copilot app.

## Read before implementing anything

1. [docs/vision.md](docs/vision.md) — what we're building and why
2. [docs/SystemInvariants.md](docs/SystemInvariants.md) — rules that are never violated
3. [docs/adr/ADR-001-topology.md](docs/adr/ADR-001-topology.md) — where everything runs
4. The doc for whatever subsystem you're touching (index below)

Never violate these documents. If an implementation conflicts with the architecture: **STOP, explain the conflict, do not silently change the architecture.** Architecture changes happen through an ADR (docs/ADR_template.md), approved by Aaron.

## Doc index

| Doc | Owns |
|---|---|
| docs/adr/ADR-001-topology.md | Client/server boundary, component placement, sync |
| docs/adr/ADR-002-stack.md | Languages, frameworks, providers, shared engines package |
| docs/adr/ADR-003-events.md | Event log semantics, envelope, idempotency, detectors |
| docs/DataModel.md | Canonical schema, money/timezone conventions, audit record |
| docs/SecurityPrivacy.md | Auth, encryption, LLM allowlist, user rights, regulatory boundary |
| docs/FinancialStateEngine.md | Derived state computation |
| docs/decisionEngine.md | Deterministic rules, two-lane learning |
| docs/verificationEngine.md | Decision classes, freshness, confidence, reconciliation |
| docs/AIArchitecture.md | Intent detection, LLM explanation, voice contract |
| docs/EventArchitecture.md | Event catalog and rules |
| docs/memoryArchitecture.md | SQL/vector/cache separation |
| docs/V1Scope.md | What v1 builds vs defers |
| docs/Reliability.md, docs/performanceBudget.md | Failure contracts, latency budgets |

## Core doctrine

SQL calculates. Rules decide. Memory contextualizes. LLM explains. Verification protects. Feedback improves.

- The LLM never performs financial calculations and never makes financial decisions.
- `high_stakes` recommendations require verification; `read_only` surfaces label their data age (docs/verificationEngine.md).
- LLM/NLU-derived facts enter canonical state only via explicit user confirmation.
- Money is integer minor units. The event log is append-only.

## When writing code

Favor readability, modularity, composition, dependency injection. Write tests — the shared engines package (`@xerebro/engines`) holds the most-tested code in the repo and must stay a pure function of its inputs (no platform APIs, no network). Keep functions small. Do not over-engineer.

Always explain architectural tradeoffs. If multiple designs exist: present options, recommend one, explain why. If a change materially affects system design, wait for Aaron's approval before implementing.
