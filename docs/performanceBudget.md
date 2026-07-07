# Performance Budget

Budgets are p90 on a mid-tier device unless noted. Every number assumes the local-first topology (ADR-001): budgets are met from device state, never by racing the network.

| Surface | Budget | Notes |
|---|---|---|
| Dashboard (cached) | 500 ms | From device SQLite; always available after first sync |
| Dashboard (refreshed) | 1 s | Background sync applied; UI never blocks on it |
| Purchase decision — within freshness window | 1 s | Cache-verified path (verificationEngine.md) |
| Purchase decision — refresh-race path | 4 s cap | 3 s refresh timeout + decision; on timeout, `CANT_VERIFY` renders immediately |
| Intent detection | 1.5 s | Keyword fallback answers instantly offline |
| AI explanation | 5 s | Deterministic decision renders first; explanation streams in; template fallback on failure |
| Voice processing (post-v1) | 3 s | On-device speech-to-text |
| Webhook → event log | 10 s | Plaid notification to normalized events persisted |
| Push notification handoff | 30 s | To APNs/FCM handoff — delivery beyond that is the platform's, not ours |

The decision always renders before its explanation: users never wait on the LLM for a verified answer (SystemInvariants.md, Reliability.md).
