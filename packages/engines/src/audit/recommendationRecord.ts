/**
 * Recommendation audit record (docs/DataModel.md, docs/SystemInvariants.md).
 * Reconstructable by RETRIEVAL, not regeneration: this record IS the
 * recommendation as shown; nothing in it is ever recomputed for display.
 */
import type { PurchaseDecision } from "../decision/purchaseApproval";
import type { VerificationResult } from "../verification/confidence";

export interface LlmRecord {
  provider: string;
  model: string;
  promptTemplateVersion: string;
  explanationTextVerbatim: string;
}

export interface RecommendationRecord {
  recommendationId: string;
  userId: string;
  /** Passed in — engines don't read clocks. */
  createdAt: string;
  decisionClass: "read_only" | "high_stakes";
  decision: PurchaseDecision;
  verification: VerificationResult;
  /** Empty until vector memory ships (docs/memoryArchitecture.md). */
  retrievedMemories: string[];
  /** Absent when the LLM fell back to a template (docs/AIArchitecture.md). */
  llm?: LlmRecord;
  templateExplanation?: string;
}

export function buildRecommendationRecord(input: {
  recommendationId: string;
  userId: string;
  createdAt: string;
  decision: PurchaseDecision;
  verification: VerificationResult;
  llm?: LlmRecord;
  templateExplanation?: string;
}): RecommendationRecord {
  return {
    recommendationId: input.recommendationId,
    userId: input.userId,
    createdAt: input.createdAt,
    decisionClass: input.decision.decisionClass,
    decision: input.decision,
    verification: input.verification,
    retrievedMemories: [],
    ...(input.llm !== undefined ? { llm: input.llm } : {}),
    ...(input.templateExplanation !== undefined
      ? { templateExplanation: input.templateExplanation }
      : {}),
  };
}
