# Xerebro budgeting baseline and verified-purchase MVP

Date: 2026-10-06. Status: proposed product/implementation specification.
Owner: Aaron Green. Companion: rocketMoneyClaudePrompt.md.

This document expands rocketMoneyProductPlan.md. It does not supersede accepted
ADRs, approve unresolved financial policies, or claim production readiness.
New models and policy changes below require the concrete review gates identified
in section 12. Existing authorized work can continue independently of those gates.

## 1. Product outcome

Xerebro should be useful as an everyday budgeting app immediately after connecting
accounts, then help users understand what a proposed purchase would leave them.

The essential loop is:

Connect → understand spending → confirm bills → set a few limits → check a purchase
→ understand the consequences → adjust the plan.

The MVP differentiator is a purchase check grounded in the same financial picture
the user sees throughout the app. It must explain obligations, reserved savings,
remaining cash, evidence quality, and why the answer was reached. AI improves
communication; deterministic engines produce financial results.

Success means one coherent journey, not Rocket Money feature parity.

## 2. Research findings and their implications

Research basis: official public Rocket Money product pages, help-center articles,
and a Rocket Companies announcement reviewed October 6, 2026. This was not a
signed-in usability study. Exact screen placement, plans, and availability vary.
The flows below are Xerebro proposals informed by documented behavior, not claims
that every Rocket Money user sees precisely this onboarding sequence.

| Finding | Evidence | Xerebro implication |
|---|---|---|
| Linked accounts feed consolidated, categorized spending | [Spend tracking](https://www.rocketmoney.com/learn/personal-finance/tracking-expenses-with-rocket-money) | Deliver useful imported information before requiring extensive setup |
| Budget setup includes income, bills, and editable historical category suggestions | [Creating a budget](https://help.rocketmoney.com/en/articles/2649810-creating-a-budget) | Use a short guided setup with user-confirmed limits |
| Bills/subscriptions have Upcoming, All, and Calendar views | [Recurring views](https://help.rocketmoney.com/en/articles/3117398-where-can-i-view-my-subscriptions-and-bills) | Make upcoming obligations a primary destination |
| Users can manually add bills, associate transactions, and adjust dates/amounts | [Managing bills](https://help.rocketmoney.com/en/articles/2185531-managing-your-bills-and-subscriptions) | Support incomplete bank coverage and correction of detected recurrence |
| Watchlists support starting with a few categories or merchants | [Budgeting approach](https://www.rocketmoney.com/learn/personal-finance/budgeting-with-rocket-money) | Budgeting must be optional and incremental |
| Advanced transaction controls include rules, notes, splits, and custom categories | [Premium features](https://help.rocketmoney.com/en/articles/2677184-premium-membership-features) | Prioritize correction and detail; postpone splits and automation |
| Safe to Spend considers obligations before payday | [Safe to Spend](https://www.rocketmoney.com/learn/personal-finance/tracking-expenses-with-rocket-money) | A bank balance alone is insufficient; preserve Xerebro's existing 30-day horizon initially |
| Rowan provides conversational assistance and actions; its announcement describes selective availability | [August 25, 2026 announcement](https://www.rocketcompanies.com/press-release/rocket-moneys-rowan-rewrites-what-ai-can-do-in-personal-finance/) | Chat alone is not a competitive distinction; emphasize evidence and inspectability |

Product interpretation: automatic organization, short paths to correction, and
low-effort ongoing use matter more than reproducing every feature or visual.
Borrow these interaction patterns while retaining Xerebro's own design system.

## 3. Current implementation and gaps

Assessment includes the staged working tree; recheck before implementation.

| Capability | Existing foundation | Remaining work |
|---|---|---|
| Home | Local cash, income/expenses, recent transactions, purchase entry | Drill-downs, budget progress, upcoming bills, actionable states |
| Spending | Transaction list; deterministic category/date queries | Complete history navigation, detail/editor, summaries/search |
| Planning | Buckets and one next-due date per bill | Monthly limits, recurring occurrences, payment settlement |
| Accounts | Local account views, lifecycle controls, continuity review | Native/Sandbox verification and update-mode decision |
| Imports | Atomic complete-update ingestion and pending identity | Actual Postgres concurrency/recovery checks |
| Sync | Durable outbox and shared committed-plus-pending snapshot | Indexed delta reads, bounded network paths, corruption repair audit |
| Purchase | Shared rules, confidence, templates, local audit, feedback | Bank reconciliation evidence, richer consequence presentation |
| AI | Aggregate tools, proxy, fallback, faithfulness eval | Known number/percentage gaps; provider/model launch validation |
| Security | Device tokens, encrypted row payloads, sealed bank tokens | Identity, app lock, page encryption, production controls and user rights |

Important limits:

- Bank balance ingestion currently initializes reconciliation as unknown.
  BankSyncCompleted establishes complete-import/handoff evidence for continuity;
  it does not establish a ledger opening balance or reconciliation proof.
- Device projections are cached in memory over encrypted stored events. Some
  changed-state reads still load the full log. Do not describe this as a fully
  indexed, persisted SQL projection without implementing and measuring it.
- App instructions reference SDK 54; package.json declares SDK 57. Resolve actual
  runtime/device compatibility before native changes; do not upgrade or downgrade
  automatically.
- Earlier test/typecheck/eval attempts stalled and were interrupted. No passing
  baseline or current test count is established by this research.

## 4. Scope and priorities

### P0: standout MVP plus essential budgeting

- First-account onboarding, explicit import progress, and usable manual entry.
- Home, Spending, Budget, Bills, Accounts; accessible purchase action.
- Monthly category summaries and limits; transaction category/note correction.
- Correct treatment of transfers/card repayments under approved policy.
- Confirmed bills/subscriptions with cadence, occurrences, and payment status.
- Existing savings buckets with clear reserve semantics.
- Purchase check with evidence status, consequences, explanation, and audit.
- Reconciliation evidence and repair sufficient for verified bank-backed checks.
- Heavy-history and concurrent-server validation; reliable failure recovery.

### P1: after the core journey works

- Recurring-charge suggestions, lightweight watchlists, calendar view.
- Optional low-balance, upcoming-bill, and category-limit alerts.
- Advance-entry matching following accountIntegrationPlan.md; until supported,
  do not expose an unsupported connected-account entry path.
- Simple goal presentation and limited user-created categorization rules.

### Deferred

Concierge cancellation, human negotiation, automated transfers, credit reports,
investment/tax advice, joint accounts, multi-currency calculations, learning lanes,
voice, vector memory, splits/partial transaction matching, and payday-based purchase
rules. No undefined Financial Health Score. Full launch security requirements remain
release gates even when they are not features of this product increment.

## 5. First-session experience

1. Welcome explains three benefits: understand spending, plan bills, check purchases.
2. Connect with the existing Plaid flow or add a manual account.
3. Import view distinguishes connecting, importing, ready, retry-needed, and
   reauthentication-needed. A partial overview is labeled incomplete, not zero.
4. Home shows available data immediately: cash, monthly spending, categories,
   recent activity, and confirmed upcoming obligations.
5. Optional bill setup: enter known bills first; later confirm recurrence suggestions.
6. Optional budget setup: select two or three categories and confirm limits.
7. Offer a sample purchase check using an amount the user enters.

Persist progress and resume after restart. Never require all accounts, a full budget,
or income disclosure to browse existing data. Distinguish no history, missing history,
empty filters, and unsupported data. Do not ask for notification permission before
the user selects an alert that benefits them.

## 6. Screen requirements

### Home

Order: concise freshness/connection status; cash and obligations summary; this-month
income/spending; purchase action; upcoming bills; selected budget progress; recent
transactions. Use existing visual components and spacing conventions.

Each card navigates to the corresponding detail with the same date/account scope.
Show source age and incompleteness inline, with detailed reasons behind a tap.
Avoid full-screen loading after local data exists. Refresh updates in the background.
Cash after bucket reservations is not labeled verified safe-to-spend.

### Spending

Month selector, total eligible spending, category breakdown, and paginated transaction
list. Filters: account, category, date range, income/expense, pending/posted; search by
merchant/description. A category opens its contributing transactions. Search applies
to complete eligible local history, not only a recent dashboard subset.

Transaction detail shows amount/currency, account, dates, status, effective category,
notes, and any history-exclusion reason. Corrections use append-only overlays.
Do not let users edit imported source amounts or hide unexplained records. Confirmed
duplicates remain accessible in history. Announce result counts and accessible labels.

### Budget

Monthly category limits are distinct from reserved savings buckets. Rows show limit,
spent, and remaining; overspending is shown as an amount, not only color. Tapping a
row opens scoped spending detail. Users can add/edit a limit and disable future
tracking without deleting historical plans. No rollover in MVP.

Historical suggestions state the period and available coverage. Sparse histories
receive no invented recommendation. The user chooses the limit. Savings buckets
remain in a separate section labeled Reserved savings.

### Bills

Upcoming and All views initially. Detail includes expected amount, next occurrence,
cadence, subscription flag, linked account when known, last confirmed payment,
and edit/stop actions. Show overdue and partial-payment states explicitly.

Paid items leave upcoming obligations; later occurrences remain. Stopping recurrence
preserves history. Cancellation help may open provider instructions; it must not claim
Xerebro cancelled the service. Recurrence suggestions have Confirm/Edit/Dismiss and
remain drafts until confirmed. Variable charges show estimates with their basis.

### Accounts

Retain existing bank/manual grouping, balance basis, masks, freshness, lifecycle,
history counts, and continuity review. Account detail opens scoped transactions.
Refresh/retry/disconnect communicate durable status. Disconnect retains history and
excludes disconnected balances. Resolve account-history uncertainty through existing
authenticated commands. Do not merge accounts by name or mask.

### Purchase result

Entry fields: integer-cent amount, optional description, optional category.
Category changes context only until a reviewed rule version explicitly uses it.

Result order: verification/result status; purchase amount; cash/obligation/reserve
breakdown; remaining cash; category impact if present; plain explanation; Why/details;
optional feedback. Verification failure must not show a recommendation disguised as
an approval badge. The cached calculation can remain visible and labeled.

Why includes the actual rules fired, input snapshot, versions, evidence age, relevant
pending actions, confidence limitation, and explanation as recorded. Reloading history
retrieves the record/amendments rather than asking the LLM to recreate it.

## 7. Financial and data contracts

All calculations use integer minor units and deterministic shared functions. All
calendar reporting uses the user's IANA timezone and local dates. Currency/type
exclusions follow ADR-005. Account continuity/exclusions follow ADR-007.

### Shared reporting semantics

Define one effective transaction policy consumed by Home, Spending, Budget, purchase
context, and server tools. Proposed baseline: posted eligible outflows count as settled
spending; pending eligible outflows are shown separately as committed/pending spend.
Do not silently change the current query convention: record and approve the policy,
then version affected behavior. Refund attribution and pending budget treatment need
explicit examples at the gate. Transfers/card repayments are not new consumption,
but still affect relevant account cash/liabilities. A removed transaction contributes
neither settled nor pending spend. Excluded duplicate/history records remain visible.

### Monthly category budget: proposed logical model

BudgetPlan: id, categoryId, local month (YYYY-MM), limitMinor, currency (USD),
timezone, enabled, updated sequence. Use a stable id and a distinct action id per
edit. Preserve prior months; cloning a prior plan creates a new month's plan.

Derived: posted spent, pending amount, remaining, over-limit amount, data age,
coverage warnings. Category limits do not subtract their full value from cash.
Already spent money must not be deducted a second time. Buckets remain actual
reservations. Purchase category impact does not automatically change the verdict.

New event names/schema are proposals to document before coding, not declarations
that existing clients already support them. Specify duplicate category/month behavior,
concurrency, validation limits, and n/n-1 compatibility.

### Bills and occurrences: proposed logical model

BillDefinition: id, name, kind, expectedAmountMinor, currency, cadence, anchor local
date, timezone, optional account, active. MVP cadence: monthly, weekly, annual;
month-end dates clamp to the last valid day. Include an explicit one-time option.

BillOccurrence: stable id, bill id, due local date, expected amount, payment references,
paid amount, status (expected/partial/paid/overdue/cancelled), updated sequence.
Generate a bounded horizon deterministically. Existing single-date bills retain their
meaning until the user confirms cadence; do not invent historical occurrences.

Payment settlement is an overlay referencing canonical posted facts, not a new
expense. Pending payments remain unsettled. Removal/correction invalidates affected
settlement and triggers review. MVP confirmation supports exact full payments; partial
amount handling must be defined before exposing it. Avoid unconstrained automatic
matches, many-to-many matches, or double-use of the same payment allocation.

### Reconciliation: required evidence, not an inferred balance

Before implementation, propose a specific evidence contract with opening timestamp,
opening settled balance, history coverage/completion, account/currency, observation
timestamps, and pending/posted treatment. Explain how those facts are obtained from
the actual bank API; never solve missing evidence by assigning zero drift.

Compare a settled ledger to compatible current-balance evidence, not available cash
to a posted ledger. Pending holds/credit direction must not create manufactured drift.
Evaluate per-account evidence and failure before aggregation. Unknown evidence stays
unknown; a failed account cannot be hidden by another account's balance or drift.
Rebuild repairs projection faults; upstream resync/append-only corrections repair
missing or wrong bank facts. If sufficient evidence cannot be obtained, disclose the
limitation and retain CANT_VERIFY rather than promising verified bank guidance.

### Consistency and audit

Use committed events plus durable pending actions for device views and checks. Never
persist provisional sequences as server order. Capture committed sequence and pending
action ids in purchase provenance. Server chat only sees canonical data; disclose
unsynced changes when asking it about a device-visible total. No raw financial history
goes to the model. User edits do not overwrite upstream facts.

## 8. Failure-mode requirements

| Failure | User experience | Recovery/invariant |
|---|---|---|
| Link exits or expires | Return to connection choice with clear status | Existing ownership/expiry rules; no duplicate item on retry |
| Import interrupted or upstream page mutates | Importing/retry status; existing data remains usable | Complete-update atomic commit; retry from durable cursor |
| Webhook repeated or workers race | No duplicated transactions | Cursor/idempotency checks and leased jobs |
| Slow job outlives lease | Work may be reclaimed without corrupting state | Audit fencing/renewal and stale-worker completion semantics before claiming exclusivity |
| Login consent expires | Connection needs attention | No retry storm; do not invent update-mode support |
| Disconnect revocation fails | Disconnected cash excluded; removal pending | Durable retry; retain audit history |
| Upload succeeds, download fails | Edit remains visible as queued | Keep outbox action until canonical copy is local |
| Device offline | Cached views/edits usable with age labels | Follow existing manual-vs-bank verification policy |
| Missing balance/history or currency/type uncertainty | Partial totals and explicit reasons | Exclude unsupported evidence; block unjustified verification |
| Continuity/matching ambiguous | Review-required items visible | Explicit confirmation; signatures/version checks |
| Bank changes a matched payment | Settlement becomes uncertain | Revalidate against canonical facts, never retain stale proof |
| Projection corrupt or ciphertext unreadable | Saved data unavailable/repair state as appropriate | Audit sequence gaps and resync; skipping a row alone is not proof of self-healing |
| Database unavailable | Safe retry response; local data usable | No successful acknowledgement before durability |
| Two devices edit same object | Deterministic documented result/conflict | Existing sequence order; version checks for protected commands |
| AI fails or invents figures | Deterministic template stands | Runtime validation; preserve exact shipped explanation |
| Client/server schemas differ | Explicit supported-version behavior | Compatibility tests; protect continuity-aware deployment |
| Network stalls during purchase | Local answer/failure within budget | Bound initial pull, upload, token refresh, and refresh race; rendering must not await unbounded I/O |

Timeout cancellation, late results, retries, and request ownership must be deliberate.
Late responses must not replace a newer purchase result or mark stale evidence fresh.
Queue-first audit persistence precedes display; remote audit upload can happen later.

## 9. Heavy users and service scale

These are proposed benchmark fixtures, not established capacity guarantees.

| Fixture | History | Accounts | Purpose |
|---|---|---|---|
| Everyday | 1,000 transactions | 5 | Normal interaction baseline |
| Heavy | 10,000 transactions | 20 | Multi-year reports, search, sync |
| Stress | 50,000 transactions | 50 | Worst supported-history exploration |

Include dense identical amounts, pending transitions, removals, annotations, continuity
chains, excluded duplicates, and queued actions. Benchmark cold start, warmed Home,
month changes, search, purchase check, rebuild, and incremental sync independently.

Existing p90 native goals: cached dashboard ≤500 ms, fresh purchase ≤1 s, stale
refresh-race ≤4 s, AI explanation ≤5 s. Measure actual supported hardware and release
builds. Proposed extra goals: warmed month switch ≤500 ms; first search page ≤500 ms;
scroll remains responsive during sync. Record memory and event-loop/frame stalls;
establish device-specific thresholds from measurements rather than inventing them.

Implementation direction:

- Indexed reads after sequence; avoid whole-log decrypt/load for every small update.
- Virtualized, paginated lists and complete-history query semantics.
- Cached/incremental aggregates with replay-equivalence tests; batch collection copies.
- Account/transaction scans approximately O(A + T) for balance state; indexed/bucketed
  candidates for matching. Bound import pages, rows, bytes, retries, and generated bills.
- Keep expensive first-build/rebuild work out of rendering; surface progress and failure.
- If persisted device projections are needed, keep financial payloads encrypted and
  preserve rebuildability. Plaintext search indexes need security review.

Server scale is separate. Use a configurable harness against a disposable database
and mocked bank gateway: initial runs at 10, 50, and 100 concurrent sessions, multiple
workers, shared-item races, and independent-user imports. Never load-test Plaid or
production infrastructure by default. These are exploratory load levels, not promises
of simultaneous supported users. Measure p50/p90/p99, throughput, errors, DB pool/lock
waits, job age, lease expiry, and memory. Identify the saturation point and document
deployment-specific limits. Bound worker concurrency and upstream rate-limit retries.

No extra queue/cache service is required without evidence that current Postgres-backed
jobs and indexes cannot meet measured needs.

## 10. Verification and release acceptance

Automated checks must exercise behavior, not duplicate implementations:

- Determinism and incremental fold equals rebuild for all new events.
- Month/timezone/DST boundaries; month-end cadence; sparse history suggestions.
- Budget edits, prior-month preservation, refunds/pending policy under approved examples.
- Pending→posted once, transfer pair once, card repayment not another purchase.
- Bill payment settlement/removal and future occurrences without double obligations.
- Outbox survives restart and upload/download failures; audit exists before display.
- Unknown reconciliation cannot approve; drift/freshness/coverage failures remain visible.
- Matched bank-fact changes invalidate evidence; competing commands are safe.
- Long jobs/lease reclaim, pagination failures, DB rollback, concurrent imports/reviews.
- AI failure, verdict contradiction, bare numbers, invented percentages, and fallback.
- Authorization, user ownership, schema compatibility, old-data upgrades and replay.

Run engine/app/server tests, typecheck, faithfulness eval, and actual Postgres tests
with the documented test database setup. Skipped DB checks are not passing DB checks.
Investigate stalled commands; report environment limitations honestly.

Native/Sandbox walkthrough: connect checking and card; interrupt/retry import; correct
category; confirm recurring bills; set monthly limit; review continuity; settle bill;
check purchase; disconnect; reload offline. Verify displayed numbers and accessible
navigation. Run benchmark fixtures on supported devices.

Launch gates additionally include identity recovery/linking, app lock, approved device
encryption, managed secrets/server encryption, TLS/pinning posture, export/deletion,
operational alerts/runbooks, and provider zero-retention terms per SecurityPrivacy.md.
Do not equate completion of this budgeting increment with permission for public launch.

## 11. Delivery plan

| Stage | Deliverable | Depends on | Completion evidence |
|---|---|---|---|
| 0 | Reproducible baseline, spec drift list, schema/runtime inventory | Existing tree | Checks reported; actual SDK/device constraint resolved |
| 1 | Reporting policy and model proposals; reconciliation evidence design | 0 | Concrete examples and required ADR approvals |
| 2 | Spending detail/edit, shared classification, indexed device reads | Applicable stage-1 decisions | Correct totals, overlays survive imports, measured heavy history |
| 3 | Monthly budgets and five-destination navigation | Budget contract; 2 | Month limits and drill-down totals agree; old data preserved |
| 4 | Bill definitions/occurrences, confirmation and settlement | Bill/matching contract; 2 | Paid bills stop reserving cash; later bills remain |
| 5 | Reconciliation collection/scoring/repair | Evidence contract; 0 | Real evidence proves compatible ledger/balance; unknown path remains safe |
| 6 | Unified purchase consequences and why inspector | 3, 4, 5 for verified bank demo | Recorded, explainable check; fast fallback without AI |
| 7 | First-session polish, optional recurring suggestions | 3, 4 | Skippable/resumable onboarding and confirmed suggestions |
| 8 | Failure, load, native/Sandbox, migration and release checks | Integrated slice | Evidence table; limits/blockers disclosed |

Stages can share infrastructure but should yield small reviewable changes. Reconciliation
design starts early; its implementation can proceed while independent UI work continues.
Do not spend weeks on speculative architecture or postpone the purchase demonstrator
until every optional feature exists. First demonstrate with manual data, then bank
evidence when it is genuinely sufficient. No schedule estimate is committed here.

## 12. Decisions and approval boundaries

Aaron explicitly permits suggesting changes to existing features (2026-10-07).
Existing screens, orchestration, and models are not fixed merely because they are
implemented. Prefer reuse where it works; propose replacement where it improves
the coherent budgeting/purchase flow, correctness, or measured performance.

Recommended changes to existing features:

| Existing feature | Proposed change | Reason and preservation requirement |
|---|---|---|
| Transactions tab | Evolve into Spending with summaries and complete-history detail | Preserve transaction ids, annotations, exclusions, and access to raw history |
| Budget screen | Separate monthly category limits from Reserved savings; move bills into Bills | Buckets retain their reserve meaning and ids; do not reinterpret saved allocations |
| Home cash card | Add an obligations/reserves breakdown and links to evidence | Preserve current cash calculation; never imply verified spending capacity from cash alone |
| Purchase orchestration | Render from local state and locally durable audit without awaiting unbounded network operations | Preserve freshness policy, bounded refresh race, outbox durability, and recorded provenance |
| Projection cache/device reads | Add indexed delta reads and measured incremental queries | Preserve encryption and replay equivalence; review persisted indexes if they expose financial data |
| Single next-due bill | Evolve into definitions and occurrences after model approval | Preserve existing obligations as entered; require confirmation before assigning recurrence |
| Purchase result | Present consequences and verification prominently, with a retrievable Why view | Keep deterministic verdicts and historical audit text unchanged |

For each material revision, record the current behavior, proposed behavior, a user
example, affected data/contracts, alternatives, and compatibility or migration plan.
Permission to suggest a change is not blanket approval to alter financial policies
or accepted architecture. Routine authorized UI/refactoring work can proceed; those
material changes follow the existing approval rules below.

Prepare concrete examples, alternatives, recommendation, affected data, and ADR draft
for these material choices:

1. Monthly-limit events/model and their separation from cash reservations.
2. Reporting policy for pending charges/refunds/transfers/card repayments.
3. Bill cadence, settlement allocation, matching and reversal semantics.
4. Source and sufficiency of opening/history reconciliation evidence.
5. Persisted device projections/search indexes if encryption or topology changes.

Accepted ADRs remain authoritative. Aaron's explicit authorization in a later session
may satisfy a gate; do not repeatedly ask for the same decision. Complete the design
and independent authorized work before requesting approval of a concrete proposal.
Do not silently relabel a proposed policy as already accepted.

## 13. MVP demonstration and outcome measures

Demonstrate a connected or manual financial picture with no inconsistent totals:
correct a category → set a dining limit → confirm rent/subscription → mark a confirmed
payment → check a purchase → inspect why → restart offline and retrieve the record.
Use known fixture amounts and assert each stage mathematically. Include an unknown
bank-evidence case that clearly refuses verification.

Track completion of account connection, first useful overview, first budget, first
purchase check, and successful uncertainty resolution. Collect aggregate durations,
failure classes, and queue ages without logging raw finances, tokens, or question text.
Performance and reliability targets are gates; conversion/retention thresholds require
real pilot observations and are not invented by this specification.
