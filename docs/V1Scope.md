# V1 Scope — The Trust-Loop Slice

Decided 2026-07-06. V1 proves the entire doctrine end-to-end on the single differentiating question — **"Can I buy this?"** — rather than shipping ten half-built engines. Everything deferred below is *designed-for* (its contracts exist in the docs) but *not built*.

## In scope

One vertical slice, every layer thin but real:

1. **Accounts:** Plaid link (checking/savings/credit) + manual accounts and manual transactions.
2. **Ingestion:** Plaid ACL → event log → projections (ADR-003), with pending/posted identity and `TransactionRemoved` handled correctly from day one.
3. **Sync:** server→device delta sync by sequence; first-sync state; rebuild-from-log repair path (ADR-001).
4. **Financial State Engine:** available cash, upcoming bills impact, bucket allocations.
5. **Decision Engine:** the **purchase-approval rule family only**, with `rules_version`/`params_version` plumbing in place even though params never change in v1.
6. **Verification:** tiered classes, refresh-race freshness, confidence, reconciliation with repair path — the full verificationEngine.md spec. This is the heart of v1 and gets the most test investment.
7. **LLM explanation:** via the redaction proxy, template-fallback, numbers substituted from the decision payload, verbatim audit storage.
8. **Audit record:** complete per DataModel.md for every recommendation.
9. **Feedback:** logged (`accepted / ignored / modified / rejected`) — **acted on by nothing**. The learning lanes stay dark in v1; we ship the sensor, not the actuator.
10. **Dashboard:** the mockups' home screen (balance, quick overview, recent transactions) rendered from local state with data-age labels.

## Build status (2026-08-14)

Items 1–10 are built. Beyond the original slice, also shipped: device-token
auth, at-rest encryption on device, offline outbox, Postgres persistence,
materialized projections, the grounded copilot (docs/copilotArchitecture.md),
and real Plaid integration — HTTP gateway, hosted Link, ES256 webhook
verification, sealed token custody, and balance sync.

Remaining before a real-user launch: identity linking (passkeys — needs a
development build), page-level SQLCipher (same dev build), an offline
explanation-faithfulness eval harness, and signed zero-retention LLM terms.

**Addendum (2026-10-06):** ADR-004 (atomic Plaid ingestion), ADR-005 (balance
evidence policy), ADR-006 (durable Plaid lifecycle), and ADR-007 (reconnected-
account continuity) are built and extend items 1–2 above; see
accountIntegrationPlan.md for the staged delivery tracker. This hardens the
original Accounts/Ingestion slice against a gap found in production-shaped
testing (duplicate spending history on bank reconnection) — it is not scope
added beyond the trust-loop question, since an unreconciled double-count would
itself make "Can I buy this?" unverifiable.

## Explicitly deferred (contracts already written)

| Feature | Where its contract lives |
|---|---|
| Voice capture + confirm-before-commit | AIArchitecture.md |
| Vector memory | memoryArchitecture.md |
| Semantic cache (explanations-only rule) | memoryArchitecture.md |
| Learning lanes 1 & 2 acting on feedback | decisionEngine.md |
| Paycheck planner | vision.md (needs bills/subscription modeling hardened first) |
| Debt/savings/goal rule families | decisionEngine.md |
| Proactive insights + detectors beyond `PaycheckReceived` | EventArchitecture.md |
| Multi-device polish, joint accounts, multi-currency | ADR-001, DataModel.md |
| Plaid update-mode reauthentication | ADR-007 (explicitly out of scope) |
| Advance-entry matching | ADR-007 (explicitly out of scope) |

## Design debt to clear before build

- **The mockups show none of the differentiators.** Before implementation starts, we need screens for: the "Can I buy this?" ask-and-answer flow, the `CANT_VERIFY` / `NEEDS_USER_INPUT` uncertainty states, the data-age label language, and the "why" inspector (rules fired + tradeoffs). The current four screens are the commodity part of the product.
- Financial Health Score appears in the vision and mockups but has no definition; it is **out of v1** and needs a spec (or removal) before it ever renders.

## Exit criteria for v1

- The two walkthrough traces pass against running software, not just docs: (1) "$600 purchase" flows question → intent → state → rules → verification → audit → explanation with every failure fallback reachable in testing; (2) a Plaid-removed pending hold flows log → projection → state → dashboard with available cash correct and no invariant violated.
- Zero-retention LLM terms signed; faithfulness eval passing; SecurityPrivacy.md device/server encryption in place.
