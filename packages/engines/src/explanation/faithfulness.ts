/**
 * Runtime faithfulness check (docs/AIArchitecture.md): mechanical, per-call
 * validation that an explanation — LLM or template — stays on the leash:
 *
 *  1. every money figure in the text exists in the legal set derived from
 *     the decision payload (the model may copy numbers, never invent them);
 *  2. the text never contradicts the verdict.
 *
 * Pure and shared: the server proxy enforces it before returning, the app
 * re-checks before rendering (defense in depth — the client doesn't have to
 * trust the server's diligence).
 */
import { formatMinor } from "../money";
import type { PurchaseDecision } from "../decision/purchaseApproval";

const MONEY_FIGURE = /\$\s?([\d,]+(?:\.\d{1,2})?)/g;

/** Normalized dollar strings (no "$", no spaces) appearing in text. */
export function moneyFiguresIn(text: string): string[] {
  return [...text.matchAll(MONEY_FIGURE)].map((m) => m[1]!.replace(/\s/g, ""));
}

/** The dollar strings a set of minor-unit values legitimizes (with and
 * without cents, since a model may round to whole dollars). */
export function legalFiguresFromMinor(values: readonly number[]): Set<string> {
  const legal = new Set<string>();
  for (const v of values) {
    const formatted = formatMinor(Math.abs(v)).slice(1); // "1,234.56"
    legal.add(formatted);
    legal.add(formatted.replace(/\.\d{2}$/, "")); // "1,234"
  }
  return legal;
}

/** Every dollar string an explanation is allowed to contain. */
export function legalMoneyFigures(decision: PurchaseDecision): Set<string> {
  const s = decision.inputsSnapshot;
  const remaining = s.availableCashMinor - s.upcomingObligationsMinor - s.amountMinor;
  return legalFiguresFromMinor([
    s.amountMinor,
    s.availableCashMinor,
    s.upcomingObligationsMinor,
    s.bufferFloorMinor,
    remaining,
    -remaining,
    ...decision.tradeoffs.map((t) => t.amountMinor).filter((v): v is number => v !== undefined),
  ]);
}

/**
 * Chat faithfulness (docs/copilotArchitecture.md): a copilot answer may only
 * contain money figures the tool actually computed. Same leash, no verdict.
 */
export function checkChatFaithful(text: string, figures: readonly number[]): FaithfulnessResult {
  const legal = legalFiguresFromMinor(figures);
  const violations = moneyFiguresIn(text)
    .filter((f) => !legal.has(f))
    .map((f) => `money figure not computed by any tool: $${f}`);
  return { faithful: violations.length === 0, violations };
}

const VERDICT_FORBIDDEN: Record<PurchaseDecision["decision"], RegExp[]> = {
  approve: [/hold off/i, /can'?t afford/i, /cannot afford/i],
  caution: [/^yes[^,]/i, /easily afford/i],
  decline: [/you can afford/i, /go for it/i, /^yes\b/i],
};

export interface FaithfulnessResult {
  faithful: boolean;
  violations: string[];
}

export function checkFaithfulness(
  text: string,
  decision: PurchaseDecision,
): FaithfulnessResult {
  const violations: string[] = [];

  const legal = legalMoneyFigures(decision);
  for (const normalized of moneyFiguresIn(text)) {
    if (!legal.has(normalized)) {
      violations.push(`money figure not in decision payload: $${normalized}`);
    }
  }

  for (const pattern of VERDICT_FORBIDDEN[decision.decision]) {
    if (pattern.test(text.trim())) {
      violations.push(`contradicts verdict "${decision.decision}": ${pattern}`);
    }
  }

  return { faithful: violations.length === 0, violations };
}
