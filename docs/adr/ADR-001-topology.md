# ADR-001: Deployment Topology — Local-First Client + Thin Backend

## Status

Accepted — 2026-07-06 (Aaron Green, Chief Architect)

## Context

The vision and invariants impose four constraints that only make sense once we decide *where each engine runs*:

1. Dashboard must always load from local cache (≤500 ms).
2. Offline mode is always available.
3. Purchase decisions complete within 1 second.
4. Bank data arrives via aggregator webhooks, which require a server.

Prior docs never assigned engines to a side of the network, which made every invariant ambiguous ("SQL calculates" — *which* SQL?).

## Decision

Xerebro is **local-first**. The device is where decisions happen; the backend is a thin ingestion and proxy layer.

### Component placement

| Component | Runs on | Notes |
|---|---|---|
| UI | Device | Reads only from device SQLite. Never blocks on network. |
| Device store (SQLite) | Device | Projection + derived state the UI and engines read. |
| Financial State Engine | Device | Recomputes derived state from the local projection. |
| Decision Engine | Device | Shared TypeScript package (see ADR-002). |
| Verification Engine | Device | Same shared package. May *request* a live refresh via the backend (refresh-race, see verificationEngine.md). |
| Intent Detection | Backend (LLM) with on-device keyword fallback | See AIArchitecture.md. |
| Event log (canonical) | Backend (Postgres) | Server-ordered, append-only. Device holds a synced replica window. |
| Aggregator adapter (Plaid ACL) | Backend | Webhook ingestion, cursor sync, normalization into events. |
| LLM proxy | Backend | Enforces field-level redaction; holds provider API keys. |
| Vector memory | Backend | Deferred in v1 (see V1Scope.md). |
| Push notifications | Backend | APNs/FCM. |
| Auth / identity | Backend + device biometric lock | See SecurityPrivacy.md. |
| Recommendation audit records | Created on device (where decisions run), synced up as `RecommendationRecorded` events | Durable in the server event log; retrievable on any device. Gap found during M4: the original table omitted this row. |

### What syncs, and in which direction

- **Down (server → device):** normalized financial events (server-ordered), rules and parameter sets **with versions**, account/institution metadata.
- **Up (device → server):** user actions as events (bucket edits, annotations, manual transactions, confirmations), feedback records, device sync cursor.

### Sync subsystem responsibilities

- Delta sync by server sequence number; full resync from snapshot as the repair path (see verificationEngine.md, balance drift).
- The server-ordered event log is the spine: whoever reaches the server first is earlier, period. Devices never invent global order.
- **Multi-device conflict policy:** user annotations and bucket edits resolve last-writer-wins **per field** by server arrival order; financial events from the aggregator never conflict (single producer). Flagged for review: if v2 adds shared/joint users, LWW-per-field must be revisited.
- First launch: the app boots into an explicit "first sync" state; the local-cache invariant applies only after the first successful sync (see SystemInvariants.md).

## Alternatives

- **Server-centric** (all engines server-side): simplest to operate and audit, but offline mode collapses to read-only and every decision pays a network round trip against a 1 s budget. Rejected: violates two invariants by construction.
- **Hybrid** (state on device, decisions on server): avoids syncing rules to devices, but decisions go dark offline and state logic lives in two places. Rejected: keeps the worst dependency (network on the critical decision path).

## Consequences

- Rules/parameters become versioned, syncable artifacts; every recommendation records which versions produced it.
- Sync is a first-class subsystem with its own tests and failure modes, not plumbing.
- Offline decisions are possible and are always labeled with data age (see verificationEngine.md).

## Tradeoffs

We accept sync complexity (replication, resync repair, per-field LWW) to buy the product's defining properties: instant dashboard, offline usability, sub-second decisions. This is the correct side of the trade for a trust-first consumer app.

## References

- vision.md (performance goals, offline), SystemInvariants.md, ADR-002, ADR-003
