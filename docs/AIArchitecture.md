# AI Architecture

The LLM is not the system. It is one subsystem, quarantined to two jobs: understanding what the user asked (intent detection) and explaining what the deterministic engines decided. It never calculates, never decides, and never writes canonical state.

## Pipeline

```text
User question
  ↓
Intent Detection            (probabilistic — explicitly outside the trust core)
  ↓
Financial State             (device SQLite, effective values)
  ↓
Decision Engine             (deterministic; rules_version + params_version)
  ↓
Verification Engine         (class-aware; refresh-race; confidence)
  ↓
[audit record written — verbatim, before anything renders]
  ↓
LLM Explanation             (via backend redaction proxy; allowlisted fields only)
  ↓
Response                    (decision + explanation + data age + "why" inspector)
```

## Intent Detection — an explicit component, not a hand-wave

- **What it is:** a structured-output LLM call (backend proxy) that maps the user's text to `{ intent, decision_class, extracted_amount?, extracted_timeframe?, target_entity? }`, plus an on-device keyword matcher as offline/latency fallback.
- **It consumes raw user text, so it sits outside the trust boundary.** The old claim "the LLM only receives verified financial state" applies to the *explanation* stage; intent detection receives the question only — never balances or transactions (SecurityPrivacy.md allowlist).
- **Failure modes:** low-margin classification → ask the user to confirm intent ("Did you mean: can you afford a $600 purchase?"); out-of-scope intents (investment/tax advice) → routed to the education-boundary response (SecurityPrivacy.md); extraction of amounts is echoed back in the answer so a misread $6,000-as-$600 is visible.
- A misrouted intent must fail loudly (confirmation), because verification checks data, not intent.

## LLM Explanation — the constrained stage

- Receives: the decision output, rules fired, tradeoffs, allowlisted aggregates, verification labels. Never raw transactions, identifiers, or merchant names (tokenized if needed).
- Every number in the explanation must come from the decision payload. The renderer substitutes numeric placeholders from the payload (`{available_cash}`) rather than trusting model-typed digits — the model cannot introduce a number that isn't in the input.
- Output is stored verbatim in the audit record; explanations are never regenerated (SystemInvariants.md).
- Fallback: if the LLM is unavailable, ship the deterministic recommendation with a template explanation. AI failure never blocks a verified decision (Reliability.md).
- **Runtime faithfulness check** at the proxy, on every response: (1) every money figure in the text must exist in the legal set derived from the decision payload; (2) the text must not contradict the verdict (a decline may never read as an approval). A failing response is discarded and the template ships instead. This is mechanical and per-call — distinct from the offline eval harness below.
- Two-beat delivery: the verdict + template render immediately; the LLM explanation replaces the prose when it arrives and is audited via a `RecommendationExplanationAdded` amendment event (EventArchitecture.md).
- Faithfulness eval harness (does the explanation accurately restate the decision?) gates launch and provider/model changes (ADR-002).

## Voice (deferred feature; contract set now)

Speech-to-text on-device. NLU extraction produces a **draft card** `{ goal, amount, timeframe, confidence }`; only an explicit user tap commits it as SQL facts (then it's user-verified data, not model output). The raw transcript goes to vector memory as context regardless. Auto-commit at any confidence is forbidden — see the confirm-before-commit decision in the plan of record.

## Copilot (chat)

The conversational assistant on the FAB follows this same pipeline with a chat
doorway: the LLM routes a question to a deterministic engine tool and phrases
its computed result — never computing numbers itself. Full design:
docs/copilotArchitecture.md.

## Hard rules

- The LLM never performs financial calculations.
- The LLM never makes or modifies financial decisions.
- LLM/NLU-derived facts reach canonical state only through user confirmation.
- All provider traffic flows through the backend redaction proxy (SecurityPrivacy.md).
