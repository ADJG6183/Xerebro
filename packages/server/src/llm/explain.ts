/**
 * Explanation service behind POST /explanations — the ONLY path to a model
 * provider (docs/SecurityPrivacy.md).
 *
 * Allowlist BY CONSTRUCTION: we never forward the request body. We PICK the
 * allowlisted fields out of it into a fresh object, format every money
 * figure server-side (the model copies strings, it never does arithmetic),
 * and build the prompt from that object alone. A client sending extra fields
 * (merchant names, account ids) finds them silently absent from the prompt —
 * proven by test, not by review discipline.
 *
 * Every response passes the mechanical faithfulness check before it leaves;
 * a failing response is discarded and the caller falls back to the template.
 */
import {
  checkFaithfulness,
  formatMinor,
  sanitizeDescription,
  type PurchaseDecision,
  type VerificationResult,
} from "@xerebro/engines";
import type { LlmGateway } from "./gateway";

export const PROMPT_TEMPLATE_VERSION = "tmpl-v1";

const SYSTEM_PROMPT = [
  "You are the explanation layer of a personal-finance app. A deterministic rules engine has ALREADY made the decision — your only job is to explain it warmly and concretely in 2-4 sentences.",
  "Hard rules:",
  "- Never change, soften, or second-guess the verdict.",
  "- Use ONLY dollar amounts present in the payload, copied exactly. Never compute or invent numbers.",
  "- If a product name is given, relate it to the user's own situation (buffer, upcoming bills). Never make market claims: no prices, no 'good deal', no product quality judgments.",
  "- No financial, investment, or tax advice beyond restating the engine's tradeoffs.",
  "- If verification status is not VERIFIED, lead with the uncertainty and its reason.",
].join("\n");

export interface ExplainRequest {
  decision: PurchaseDecision;
  verification: VerificationResult;
}

export interface ExplainResponse {
  text: string;
  provider: "openai";
  model: string;
  promptTemplateVersion: string;
}

export class UnfaithfulExplanationError extends Error {
  constructor(public readonly violations: string[]) {
    super(`explanation failed faithfulness check: ${violations.join("; ")}`);
  }
}

/** Pick + format: the ONLY object the prompt is built from. */
export function buildPromptPayload(req: ExplainRequest) {
  const s = req.decision.inputsSnapshot;
  const remaining = s.availableCashMinor - s.upcomingObligationsMinor - s.amountMinor;
  return {
    verdict: req.decision.decision,
    riskScore: req.decision.riskScore,
    rulesFired: req.decision.rulesFired,
    tradeoffs: req.decision.tradeoffs.map((t) => ({
      code: t.code,
      ...(t.amountMinor !== undefined ? { amount: formatMinor(t.amountMinor) } : {}),
    })),
    amounts: {
      purchase: formatMinor(s.amountMinor),
      availableCash: formatMinor(s.availableCashMinor),
      upcomingBills30d: formatMinor(s.upcomingObligationsMinor),
      bufferFloor: formatMinor(s.bufferFloorMinor),
      remainingAfterPurchase: formatMinor(remaining),
    },
    ...(sanitizeDescription(s.description) !== undefined
      ? { product: sanitizeDescription(s.description) }
      : {}),
    verification: {
      status: req.verification.status,
      confidencePercent: Math.round(req.verification.confidence * 100),
      dataAgeHours: Math.floor(req.verification.dataAgeSeconds / 3600),
      ...(req.verification.reason !== undefined ? { reason: req.verification.reason } : {}),
    },
  };
}

export async function explainDecision(
  gateway: LlmGateway,
  req: ExplainRequest,
): Promise<ExplainResponse> {
  const payload = buildPromptPayload(req);
  const { text, model } = await gateway.complete({
    system: SYSTEM_PROMPT,
    user: JSON.stringify(payload),
  });

  const result = checkFaithfulness(text, req.decision);
  if (!result.faithful) throw new UnfaithfulExplanationError(result.violations);

  return { text, provider: "openai", model, promptTemplateVersion: PROMPT_TEMPLATE_VERSION };
}
