# ADR-006: Durable Plaid connection lifecycle

- Status: Accepted
- Date: 2026-09-12
- Decision owner: Aaron Green

## Context

Exchanging a Plaid public token and importing balances/transactions are
separate operations. Webhooks can also arrive while the server is restarting
or Plaid is temporarily unavailable. Running all of that work only inside an
HTTP request can lose the instruction to finish an import.

Users also need an honest disconnect: stop future bank access, keep the
already-imported financial history for auditability, and stop treating the
old bank balance as spendable cash.

## Decision

- Persist one small PostgreSQL job per Plaid item and operation. Jobs have a
  lease, attempt count, next-attempt time, and a bounded public status.
- Token exchange persists the item before import and queues resumable sync
  work. Webhooks enqueue work and acknowledge quickly.
- Interactive link/refresh requests may try the queued job immediately, but
  the durable worker remains the recovery path after a crash or timeout.
- Transient failures retry with bounded exponential backoff. Login-required
  failures stop automatic retries and become `reauthentication_needed`.
- Disconnect immediately makes the item's imported accounts non-spendable,
  retains their transactions, and queues Plaid `/item/remove`. The item row is
  retained without a usable access token so ownership and audit history remain.
- Use the existing PostgreSQL deployment rather than adding a queue service.
  Schema changes are additive and version-recorded.
- Persist link-token ownership as a hash with expiry so a restart does not
  break an otherwise valid Link session. Delete the ownership record after a
  successful completion.

## Consequences

The system can resume incomplete imports and disconnects after restarts,
avoids duplicate concurrent work through row leases, and can show users what
is actually happening. It adds a polling worker and a few lifecycle tables,
but not another infrastructure dependency.

Reconnect/update mode is intentionally a later decision. A disconnected Item
cannot be revived after `/item/remove`; it must go through a new Link flow.
