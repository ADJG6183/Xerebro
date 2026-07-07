# ADR-002: Technology Stack

## Status

Accepted — 2026-07-06 (Aaron Green, Chief Architect)

## Context

ADR-001 places the deterministic engines on the device while the backend ingests events and proxies the LLM. The same decision logic (and its tests) must therefore be runnable on both sides without drift — that constraint drives the language choice more than any framework preference.

## Decision

| Layer | Choice | Rationale |
|---|---|---|
| Mobile app | **React Native + Expo** | One language (TypeScript) across app, engines, and backend; Expo provides SQLite, background tasks, OTA updates. |
| Engines | **Shared TypeScript package** (`@xerebro/engines`) | State, Decision, and Verification engines are pure, dependency-injected TS modules with one test suite, executed identically on device and server. No engine code may import platform APIs. |
| Backend | **Node + TypeScript** (Fastify or Hono — boring by design) | Webhook fan-in and LLM proxying are I/O-bound; shares event-schema types with the client. |
| Server DB | **Postgres** | Canonical event log + projections + auth. |
| Device DB | **SQLite** (encrypted; see SecurityPrivacy.md) | Projection replica + derived state. |
| Bank aggregator | **Plaid**, behind an anti-corruption layer | `transactions/sync` cursor API maps added/modified/removed → `TransactionPosted/Updated/Removed` (ADR-003). ACL keeps the vendor swappable. |
| LLM provider | **OpenAI**, behind the backend redaction proxy | Zero-data-retention API terms are a **non-negotiable prerequisite** to go-live. An explanation-faithfulness eval harness must pass before launch and is rerun on provider/model change. |

## Alternatives

- **Flutter**: excellent UI layer, but Dart engines cannot be shared with any sensible backend — decision logic written and tested twice is drift waiting to happen. Rejected.
- **Native Swift (iOS-first)**: best platform integration (on-device speech, widgets), but halves the market and forfeits engine sharing. Revisit for on-device speech in the voice milestone.
- **Python/Go backend**: fine runtimes, but they break the single-language engine guarantee. Rejected.
- **Claude / other LLM providers**: comparable capability; this is a commercial and eval decision, not an architectural one. The LLM proxy is the seam — swapping providers later is a contained change plus an eval rerun.

## Consequences

- The engines package is the most-tested code in the company; platform code stays thin around it.
- Event schemas live in one shared package; there is exactly one definition of every event type.
- Provider lock-in risk is contained at the proxy; prompts and evals are versioned artifacts.

## Tradeoffs

React Native occasionally needs native modules for heavy platform work (speech, widgets). Accepted: those features are deferred past v1 (V1Scope.md), and the shared-engine guarantee is worth more than day-one platform polish.

## References

- ADR-001, ADR-003, SecurityPrivacy.md, V1Scope.md
