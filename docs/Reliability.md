# Reliability

# Reliability

## Plaid lifecycle

Plaid webhooks are notifications, not work containers. The server verifies the
webhook, durably upserts one job per Item, and acknowledges it without waiting
for bank calls. Workers lease due rows with `FOR UPDATE SKIP LOCKED`, allowing
multiple processes without duplicate concurrent work.

Transient sync/removal failures retry with exponential delays from 5 seconds,
capped at one hour. Expired leases are reclaimable after 60 seconds. A
login-required error becomes `reauthentication_needed` and does not spin in the
background. Interactive refresh claims only its own Item's job.

Link completion stores the sealed access-token reference, `importing` state,
and first sync job in one PostgreSQL transaction. Disconnect similarly stores
`disconnecting` plus its removal job atomically. Disconnect events make the
cached account balance non-spendable before external revocation retries, while
retaining imported transactions for audit history (ADR-006).

## Checklist

Retry

Circuit Breakers

Idempotency

Graceful Degradation

Fallback Modes

Offline Support

Audit Logging

Error Classification

Monitoring

Every component documents:

Recovery

Retry Strategy

Fallback

Timeout
