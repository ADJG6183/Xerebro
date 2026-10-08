# ADR-005: Balance evidence and spending capacity

## Status

Accepted — 2026-09-05 (Aaron Green).

## Context

Banks do not always report an available balance, current balances can omit
pending withdrawals, pending deposits may still fail, currencies cannot be
added without conversion, and unfamiliar account types may not be spendable.
Treating any of those unknowns as ordinary cash can produce unsafe purchase
advice.

## Decision

Xerebro computes USD spending capacity per active cash account using this
order:

1. Use a bank-reported available balance when present.
2. Otherwise use current balance minus known pending withdrawals. Never add
   pending deposits to spending capacity.
3. If neither balance is known, exclude the account and label the total.
4. Exclude non-USD accounts from the USD total. Do not invent exchange rates.
5. Retain unknown account types for display but do not assume they are cash.

Manual USD accounts remain ledger-based. Bucket allocations may make available
cash negative; that existing over-allocation is shown explicitly.

Bank reconciliation begins as `unknown`. A fresh balance alone is not proof
that imported history is complete. Bank-backed high-stakes guidance therefore
cannot be `VERIFIED` until a trustworthy opening checkpoint and history
coverage establish reconciliation. Read-only totals may still render, but
must state when balances, currencies, types, fallback calculations, or
reconciliation are uncertain.

## Consequences

- Missing data can reduce or block confidence but cannot inflate spendable
  cash.
- Some bank-backed recommendations will say "can't verify" before
  reconciliation evidence exists.
- Account projections carry explicit balance-known and reconciliation fields.
- USD totals remain deterministic and do not depend on a live FX service.
- Financial-state calculation scans transactions once and accounts once,
  targeting O(T + A) work.

## Alternatives

- Treat current as available. Rejected because it can ignore pending
  withdrawals.
- Count pending deposits. Rejected because authorization is not settlement.
- Default missing currency to USD or unknown account types to cash. Rejected
  because both manufacture certainty.
- Declare zero reconciliation drift from a fresh snapshot. Rejected because
  comparing a balance to itself does not validate transaction history.

## References

SystemInvariants.md, FinancialStateEngine.md, verificationEngine.md,
accountIntegrationPlan.md
