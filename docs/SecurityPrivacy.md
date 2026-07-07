# Security & Privacy

This document is normative. A feature that cannot satisfy it does not ship. (Regulatory notes below are engineering posture, not legal advice — counsel reviews before launch.)

## Identity & auth

- Sign-in: email + passkey (WebAuthn) as primary; Apple/Google sign-in as convenience. No passwords stored by us.
- Sessions: short-lived access token + rotating refresh token, bound to a device record. Server can revoke per-device.
- **App lock:** biometric (Face ID / fingerprint) with PIN fallback, required by default for opening the app and always required for viewing account numbers or changing security settings.

## Data at rest

- **Device:** SQLite encrypted (SQLCipher-class encryption); the database key lives in the platform keystore (iOS Keychain / Android Keystore), never in app storage. App data excluded from unencrypted cloud backups.
- **Server:** Postgres encrypted at rest; column-level encryption for aggregator tokens; secrets in a managed KMS, never in env files or the repo.
- **Plaid access tokens live server-side only.** The device never sees, stores, or transmits an aggregator token. Token rotation on any suspected compromise; item deletion revokes tokens at Plaid.

## Data in transit

TLS 1.2+ everywhere, certificate pinning in the mobile app for the Xerebro API.

## LLM data-minimization contract

The backend LLM proxy is the **only** path to any LLM provider, and it enforces an allowlist. Nothing else may be sent, and adding a field to this table is a reviewed change to this document.

| Allowed out | Never out |
|---|---|
| Derived aggregates (available cash, savings rate, debt ratio, goal progress %) | Account numbers, masks, Plaid ids, tokens |
| The decision output + rules fired + tradeoffs (the thing to explain) | Raw transaction lists |
| Category-level spending summaries | Merchant names (tokenized as `MERCHANT_1` if contextually needed) |
| User's question text (post intent-detection) | Name, email, address, phone, any direct identifier |
| Data-age / verification status labels | Voice audio or full transcripts |

- **Zero-data-retention API terms with the provider (OpenAI) are a launch prerequisite.** No training on our data, no retention beyond transient processing. If terms change, the proxy blocks until renegotiated.
- Provider swap is a proxy-level change (ADR-002) plus an eval rerun.

## Voice data (deferred feature; policy set now)

Speech-to-text on-device whenever the platform supports it. Raw audio never leaves the device. Transcripts are user-visible, deletable, and stored under the same encryption as financial data. Voice-derived facts enter canonical state only via user confirmation (AIArchitecture.md).

## User rights (GDPR/CCPA posture)

- **Delete:** full account deletion within 30 days: event log, projections, annotations, recommendation records, embeddings; Plaid item removal; provider-side nothing to delete (zero retention).
- **Export:** machine-readable export of accounts, transactions (with annotations), goals/buckets, and recommendation history.
- **Consent:** behavioral learning (feedback lanes, decisionEngine.md) is disclosed in-product; Lane 2 changes are individually user-approved by design.

## Regulatory boundary: education, not advice

- v1 provides **budgeting and cash-flow guidance grounded in the user's own verified data** — spending, saving, bill planning, purchase affordability.
- v1 does **not** provide investment, securities, retirement-allocation, or tax recommendations ("Should I increase my Roth contribution?" is out of scope and the intent detector must route it to a "we don't advise on investments" response).
- Every recommendation carries "based on your data, for your consideration" framing; the user always decides. Crossing into investment guidance later is a business decision requiring counsel (RIA analysis), not a feature flag.

## Compliance & operations posture

- GLBA safeguards orientation from day one; SOC 2 readiness (access control, audit logging, vendor review) before any open launch.
- Audit logging on all access to financial data; alerting on anomalous access.
- Incident response: documented runbook, user notification policy, Plaid token revocation as first containment step.

## References

ADR-001, ADR-002, AIArchitecture.md, DataModel.md
