# Rocket Money baseline: proposed Xerebro product plan

Research date: October 6, 2026. Status: proposal, not an accepted ADR or a change
to existing architecture. Based on Rocket Money's public product pages and help
articles, not a hands-on review of a signed-in account. Screen variants, eligibility,
and subscription tiers can differ. Xerebro assessment includes the current staged
working tree.

## Product direction

Make Xerebro a useful everyday budgeting app from the first account connection.
Build a familiar loop: understand my money, review what is coming, adjust my plan,
and check a purchase. Keep financial decisions deterministic and audited under
the existing invariants. AI provides a convenient explanation and question interface.

Rocket Money already markets Safe to Spend and offers Rowan, an AI assistant.
Our proposed distinction is evidence-backed purchase guidance, inspectable tradeoffs,
honest uncertainty, and usable local data—not simply adding chat to a dashboard.

## Findings from Rocket Money

- Account connection automatically imports and categorizes transactions, producing
  a consolidated financial picture. [Spend tracking](https://www.rocketmoney.com/learn/personal-finance/tracking-expenses-with-rocket-money)
- Budget setup walks through income, recurring bills, and monthly category targets.
  Historical spending supplies editable suggestions. [Budget setup](https://help.rocketmoney.com/en/articles/2649810-creating-a-budget)
- Recurring expenses have Upcoming, All, and Calendar views. Users can manually
  add a bill, associate transactions, and correct billing details.
  [Recurring views](https://help.rocketmoney.com/en/articles/3117398-where-can-i-view-my-subscriptions-and-bills)
  [Bill management](https://help.rocketmoney.com/en/articles/2185531-managing-your-bills-and-subscriptions)
- Watchlists let users begin with a few merchants or categories instead of creating
  a complete budget. Transfers and credit-card payments are filtered from spending.
  [Budgeting approach](https://www.rocketmoney.com/learn/personal-finance/budgeting-with-rocket-money)
- Premium adds capabilities including transaction rules, splits, notes, custom
  categories, net worth, automated savings, and cancellation assistance.
  [Premium features](https://help.rocketmoney.com/en/articles/2677184-premium-membership-features)
- Safe to Spend accounts for obligations before payday. Rowan adds conversational
  help and actions; the August 25 launch announcement describes a selective rollout.
  [Safe to Spend](https://www.rocketmoney.com/learn/personal-finance/tracking-expenses-with-rocket-money)
  [Rowan announcement](https://www.rocketcompanies.com/press-release/rocket-moneys-rowan-rewrites-what-ai-can-do-in-personal-finance/)

## Proposed first-session flow

1. Welcome: "See your spending, plan your bills, and check purchases."
2. Connect a bank or add a manual account; allow another connection later.
3. Show import progress and allow exploration of available data. Distinguish
   incomplete imports from genuinely empty history.
4. Present the first overview: current cash, this month's income/spending, largest
   spending categories, and upcoming confirmed bills.
5. Offer recurring-charge suggestions with Confirm, Edit, and Not recurring.
   Suggestions do not become canonical bill facts without confirmation.
6. Offer a lightweight budget setup: confirm income and choose a few category
   limits, using clearly labeled historical averages when coverage is sufficient.
7. Land on Home with an optional "Check a purchase" action.

Budget setup and recurring review can be skipped and resumed from Home. Never
require a complete financial plan to see useful imported information.

## Proposed navigation and daily loop

Five destinations: Home, Spending, Budget, Bills, Accounts. Keep Ask Xerebro
available as a secondary button. Spending contains both category summaries and
the transaction list. Savings buckets initially live inside Budget.

| Destination | Main contents | Main interaction |
|---|---|---|
| Home | Month summary, upcoming bills, budget progress, purchase check, recent activity | Tap a card to reach its detail |
| Spending | Month selector, category breakdown, comparison, searchable transactions | Category → transactions → edit category/note |
| Budget | Monthly category limits, actual spending, remaining amount, reserved savings | Change a limit or inspect its transactions |
| Bills | Upcoming and All views; subscriptions; expected charges | Confirm/edit bill, inspect payments, add manually |
| Accounts | Bank/manual grouping, balances, sync status, connection controls | Account → history; refresh or resolve connection |

Home should answer: What happened this month? What is coming next? What needs
my attention? Keep detailed verification evidence behind a visible explanation
or review action. Show concise data-age and incompleteness labels on affected totals.

Do not label cash remaining after buckets as "safe to spend": existing bills and
verification evidence must also be considered. Begin with "Cash available" and
an explicit obligations breakdown. Preserve the current 30-day purchase horizon;
payday-based guidance is a later product/rules decision.

## Delivery sequence

### 1. Complete the everyday spending flow

Reuse existing Home, Transactions, Accounts, and deterministic spending queries.
Add a month selector, category summary, search/account/category filters, transaction
detail, category correction, and notes. Make Home cards open those details. Persist
corrections as user overlays so bank updates do not overwrite them.

Finish transfer and credit-card-payment classification alongside these reports;
otherwise monthly totals can appear polished but be misleading. Uncertain cases
remain visible for review. Reuse stage 5 of accountIntegrationPlan.md.

Acceptance: the user can explain a monthly category total by opening its transactions;
confirmed internal transfers and card repayments do not inflate spending; corrections
survive sync and restart.

### 2. Add real monthly category budgets

Current buckets reserve cash; they are not monthly spending limits. Introduce a
separate monthly category-budget concept and retain buckets as reserved savings.
Show target, spent, remaining, and a simple progress bar. Start with fixed calendar
months, user-selected limits, and no rollover or split transactions.

Historical suggestions are deterministic calculations with a stated period and
coverage; the user confirms the limit. Watching a category must not automatically
reserve its full monthly limit from current cash or double-subtract expenses.

Acceptance: a $400 dining budget with $250 of eligible spending shows $150 remaining;
changing the limit updates the view; a new month starts a new spending period.
Document the new model and its relationship to purchase capacity before implementation.

### 3. Build the Bills and Subscriptions experience

Move the existing upcoming-bill list into a dedicated destination. First support
manual and confirmed recurring items, cadence, editable expected amounts/dates,
and payment matching. Then add conservative recurring suggestions based on
transaction history. Begin with Upcoming and All; a calendar is optional polish.

Track bill occurrences and paid/partial/overdue status so yesterday's paid bill
does not remain a future obligation. Match advance entries to bank facts using
the existing integration plan rather than building a competing matching system.
Subscription details can include provider cancellation instructions and a reminder;
do not promise concierge cancellation.

Acceptance: confirming a monthly bill creates future occurrences; a confirmed
payment settles its occurrence without counting the same expense twice; changing
or stopping recurrence preserves prior history.

### 4. Connect the familiar app to verified purchase guidance

Expose "Check a purchase" on Home and from relevant budget detail. Reuse the
existing purchase rules, audit records, and explanation fallback. Show the effect
on cash, upcoming obligations, and reserved funds; add category-limit impact as
context once its semantics are defined. Do not silently alter the verdict rules.

Example: "A $120 purchase would leave $X after your next 30 days of bills and
reserved savings." If bank reconciliation is unknown, show the cached calculation
with "Cannot verify yet" and a concrete explanation instead of an approval.

Reconciliation evidence and release validation run alongside these product increments.
Reliable verified bank guidance depends on completing that work.

## Scope boundaries

Keep credit reports, human bill negotiation, managed subscription cancellation,
automatic savings transfers, investment advice, household sharing, and broad AI
automation outside this baseline. These require additional operations, integrations,
or previously deferred scope. Add ordinary savings goals and selective alerts later,
after budgets and bill occurrences work consistently.

This plan proposes changes to the original V1 scope, especially category budgets
and recurring detection. It does not authorize architecture changes or money movement.

## Completion scenario

A user connects checking and a credit card, reviews imported spending, corrects a
category, confirms rent and a subscription, sets a dining limit, and checks a purchase.
Home, Spending, Budget, Bills, and the purchase result agree on the same underlying
facts. A card repayment does not become another purchase, a paid bill stops being
reserved again, offline edits persist, and uncertain history is clearly labeled.

Validate that scenario through unit/integration checks, actual Postgres tests, a
Plaid Sandbox/native walkthrough, and supported-device performance measurements.
No date or effort estimate is committed by this proposal.
