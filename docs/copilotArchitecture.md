# Copilot Architecture — Grounded Conversational Assistant

Status: Accepted 2026-07-12 (Aaron). Milestone A.

The center FAB opens a chat copilot the user can ask about their finances.
It obeys the same doctrine as the rest of the app — **SQL calculates, rules
decide, LLM explains** — with a chat doorway. It is NOT a RAG-over-transactions
bot.

## The one rule that shapes everything

**The LLM never computes a number, and raw transactions never leave to the
provider.** A question like "how much did I spend on dining in June?" is
answered by a deterministic engine function (`spendByCategory`), not by the
model summing rows. The model's only jobs are (1) **route** — pick which tool
answers the question and with what arguments — and (2) **phrase** — turn the
tool's computed result into a sentence, under the faithfulness leash.

This preserves three invariants a naive RAG bot would break: LLM-never-
calculates (SystemInvariants.md), the raw-transactions-never-out allowlist
(SecurityPrivacy.md), and reconstructability (every figure traces to a
computation).

## The turn pipeline

```text
question
  ↓ (only the question text + today's date leave to the provider)
ROUTE      LLM picks { tool, args } from the tool registry
  ↓
EXECUTE    the engine tool folds the user's event log deterministically
           → a structured result carrying the computed money figures
  ↓ (only the COMPUTED aggregates leave to the provider — never raw rows)
PHRASE     LLM writes the answer from the result
  ↓
VERIFY     faithfulness check: every money figure in the answer must be in
           the tool result's figure set, or the answer is rejected and a
           deterministic template answer ships instead
  ↓
answer + trace (which tool ran, with what result)
```

Tool execution runs **server-side**: the server already holds the canonical
event log (Postgres) and the shared engines package, so it computes without
any new data disclosure. Only the question and the computed aggregates ever
reach the provider (SecurityPrivacy.md allowlist — unchanged; aggregates were
already allowed, raw transactions were already forbidden).

## The tool registry (engines)

Each tool is a pure function `(events, args) → ToolResult` plus a schema
(name, description, params) the router is shown. v1 tools:

- `spendByCategory` / `spendTotal` / `topCategories` — spending aggregates over
  a date range.
- `financialSummary` — available cash, net worth (reads the state engine).
- `billsDue` — obligations within N days (reads folded bills).

`ToolResult` carries `figures: MinorUnits[]` — the exact set of money values
the phrasing is allowed to use. This is the chat analogue of a decision's
`legalMoneyFigures` and feeds the same faithfulness checker.

Date-range interpretation ("June", "last month") is intent parsing done by the
router into concrete `{fromDate,toDate}` args — probabilistic, outside the
trust core (AIArchitecture.md), and it can only select *which* deterministic
computation runs, never the numbers themselves.

## Class & audit

Copilot answers are `read_only` (verificationEngine.md): they report computed
facts, they never move money or make a `high_stakes` decision. Each turn
returns its tool trace so the client can show "based on your data". Persisting
chat history and vector memory for soft context (goals, preferences, past
chats) is **Milestone B** — deferred (memoryArchitecture.md).

## Deferred / hardening

- Native provider tool-calling (function-calling API) instead of prompt-based
  JSON routing — more robust; a contained gateway change.
- Multi-tool answers and follow-up turns (v1 is one tool per question).
- Affordability ("Can I buy this?") stays its own dedicated flow, not a chat
  tool, by product decision.
