# ADR-004: Atomic Plaid ingestion commit

## Status

Accepted — 2026-09-05 (Aaron Green).

## Context

One Plaid update can span several pages. A pending transaction's removal and
its posted replacement may appear on different pages. Today each page writes
events, identity aliases, and the cursor separately. A crash or concurrent
refresh can therefore save only part of the story or advance the cursor past
data that was not committed consistently.

In plain terms: the bank can send one update in several envelopes, but Xerebro
must not file the first envelopes and mark the whole delivery complete.

## Decision

Fetch and validate a complete Plaid update outside the database transaction.
Normalize its pages together so pending removals can be paired with posted
replacements across page boundaries.

Add one persistence operation that atomically:

1. verifies the item's stored cursor still equals the cursor used to fetch;
2. appends normalized events in deterministic order;
3. writes canonical transaction ids and aliases;
4. advances the item to the final cursor, which is the durable processing
   marker for this ordered feed.

Postgres performs these writes in one transaction. It locks the Plaid item
first, then uses the existing per-user sequence lock. All ingestion paths use
the same lock order. Network calls never occur while database locks are held.

If the starting cursor changed, another worker won the race. The stale result
is discarded and retried from the new cursor. A pagination mutation, invalid
payload, unchanged cursor while more pages are promised, page-limit breach,
or database error leaves the stored cursor unchanged and schedules a retry.

The in-memory adapter implements the same contract so shared contract tests
remain meaningful. Database changes are additive and versioned; startup
`CREATE TABLE IF NOT EXISTS` remains only a development bootstrap.

## Alternatives

- Commit each page independently and keep cross-page pending state. This uses
  less memory but still exposes partial updates and requires durable temporary
  state plus more recovery logic.
- Hold a database transaction open while fetching Plaid pages. This creates a
  simple boundary but makes slow external network calls hold locks and database
  connections, increasing contention and failure risk.
- Use a separate queue service now. It improves operational isolation but adds
  infrastructure before the current scale needs it; a durable Postgres job can
  provide recovery first.

## Consequences

- A Plaid update becomes all-or-nothing from Xerebro's perspective.
- Pending-to-posted identity works across pages without losing transactions.
- Concurrent webhook and manual refresh requests cannot corrupt cursor order.
- Normalization temporarily retains one bounded update in memory. Existing
  page and transaction limits cap this cost; exceptionally large updates can
  later be staged without changing the commit contract.
- The persistence interface becomes broader because correctness spans stores.
  This is intentional: separate store calls cannot provide one transaction.

## Tradeoffs

We accept a larger persistence operation and bounded in-memory buffering to
gain correct recovery and concurrency. The alternative is simpler code that
can silently lose financial facts, which conflicts with the trust contract.

## References

ADR-003, EventArchitecture.md, SystemInvariants.md, Reliability.md,
accountIntegrationPlan.md
