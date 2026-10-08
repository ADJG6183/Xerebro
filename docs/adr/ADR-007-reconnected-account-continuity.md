# ADR-007: User-confirmed history across bank reconnections

Status: Accepted — Aaron approved the reconnection/history direction and implementation.

## Context

Removing a Plaid Item ends that connection. Linking the same real account again
can create new account and transaction IDs. Counting both imported histories
would overstate spending. Names and masks alone do not establish identity.

## Decision

- Preserve every bank fact and annotation. Store account decisions and transaction
  reviews as append-only overlays; never rewrite the old account or delete duplicates.
- When a newly observed bank account has compatible disconnected predecessors
  (type and currency), atomically create its account record and a pending review.
  Candidate metadata is a prompt, not proof. The user selects the previous account
  or confirms that this is a different account.
- Only active account balances count as current cash/net worth. A predecessor's
  disconnected balance never becomes a second current balance.
- For confirmed continuity, use the predecessor's last complete balance-and-
  transaction sync timestamp as handoff evidence. Convert it to a calendar date
  in the user's device/profile IANA time zone, supplied with the confirmation and
  validated on the server. That entire day, earlier imports, and undated imports
  require transaction review. Extend the review window through any later-dated
  transactions already saved in predecessor history (including imports committed
  just before a crash prevented the completion marker). Dates after that window
  count normally; the checkpoint itself is never rewritten.
- No historical sync checkpoint is invented from a balance observation. When
  none exists, imports remain review-required regardless of date. This conservative
  mode can require substantial review for legacy connections.
- While account identity is pending, exclude its imported spending history. Keep
  excluded records visible and label totals incomplete. Withhold verified purchase
  recommendations while any account/history uncertainty remains.
- Pending bank withdrawals still reduce the current-minus-pending cash fallback,
  even if excluded from spending history. A spending duplicate and an outstanding
  bank withdrawal answer different questions.
- Suggest exact posted matches using currency, signed integer amount, posted date,
  and normalized raw merchant description. Only explicit user confirmation suppresses
  the replacement record. Users can instead count it separately or undo a review.
  No fuzzy matching, automatic matching, split matches, or manual-to-bank conversion.
- Recheck bank-fact signatures and one-to-one constraints in the projection, not
  just at save time. Source corrections/removals or reopened account decisions
  invalidate stale reviews. Competing matches become uncertain again.
- Support account chains, not forks or cycles. Later replacements can match
  retained original history across their predecessors. Change descendants before
  reopening an ancestor's account decision.
- Authenticate review commands server-side. Bind retries to the original command
  payload. Use expected entity versions plus the existing per-user sequence lock
  to make validation-and-append optimistic and atomic across devices and ingestion.
  Direct device-uploaded review events are forbidden. This is a second, outer
  layer, not a replacement for the ADR-003 event envelope: the command-level
  version check guards the synchronous HTTP retry path (ADR-001 exception, see
  "What syncs"), and once a command validates, the event it appends still carries
  its own ADR-003 envelope and `idempotency_key` like any other log entry.

## Alternatives and tradeoffs

Automatic name/mask merges are easier but unsafe. Dropping all older imports
would conceal genuine missing purchases. Asking users to review uncertainty is
more work, but preserves evidence and makes every adjustment reversible.

The event-store sequence lock avoids another authoritative matching table. Review
commands replay a consistent history prefix and retry bounded conflicts. Batch
transaction folds copy collections once, not once per event; candidate matching
uses keyed buckets instead of an unrestricted transaction-pair scan. Dense identical
purchases still cost time proportional to the candidates shown.

## Release boundaries

No database backfill or destructive migration is required. Existing disconnected
accounts without completion evidence use the conservative unknown-checkpoint mode.
Unexpected reused bank account IDs fail safely rather than overwrite saved identity.
Pre-existing duplicate connections are not automatically repaired.

Deploy this only with continuity-aware clients: older clients that ignore new
overlay events do not apply these exclusions. Native Expo SDK 54/Plaid Sandbox
walkthrough and supported-device latency measurements remain release checks.
This does not implement Plaid update-mode reauthentication or advance-entry matching.

## References

ADR-003, ADR-004, ADR-005, ADR-006, DataModel.md, accountIntegrationPlan.md.
