/**
 * Template explanation — the deterministic fallback path in
 * docs/AIArchitecture.md ("if the LLM is unavailable, ship the deterministic
 * recommendation with a template explanation"), and v1's ONLY path until the
 * LLM proxy milestone.
 *
 * Every number is formatted from the decision payload by code — exactly the
 * substitution rule the AI doc mandates for the LLM later, proven here first.
 */
import { formatMinor } from "../money";
import type { PurchaseDecision } from "../decision/purchaseApproval";
import type { VerificationResult } from "../verification/confidence";

export function renderTemplateExplanation(
  decision: PurchaseDecision,
  verification: VerificationResult,
): string {
  const { amountMinor, availableCashMinor, upcomingObligationsMinor, bufferFloorMinor } =
    decision.inputsSnapshot;
  const remaining = availableCashMinor - upcomingObligationsMinor - amountMinor;
  const amount = formatMinor(amountMinor);

  if (verification.status === "NEEDS_USER_INPUT") {
    return `I can't answer yet — I'm missing: ${verification.missingInputs.join(", ")}.`;
  }
  if (verification.status === "CANT_VERIFY") {
    const hours = Math.floor(verification.dataAgeSeconds / 3600);
    return (
      `I can't verify your balances right now (${verification.reason ?? "data unavailable"}). ` +
      `Based on data from ${hours}h ago you would have ${formatMinor(remaining)} left after ` +
      `${amount} and the next 30 days of bills — but treat that as a sketch, not an answer.`
    );
  }

  switch (decision.decision) {
    case "approve":
      return (
        `Yes — you can afford ${amount}. After it and ${formatMinor(upcomingObligationsMinor)} ` +
        `of upcoming bills, ${formatMinor(remaining)} stays available, above your ` +
        `${formatMinor(bufferFloorMinor)} buffer.`
      );
    case "caution":
      return (
        `You can cover ${amount}, but it cuts your cushion to ${formatMinor(remaining)} — ` +
        `below the ${formatMinor(bufferFloorMinor)} buffer you set. Doable, not comfortable.`
      );
    case "decline":
      return (
        `This would put you ${formatMinor(-remaining)} short of covering the next 30 days ` +
        `of bills. I'd hold off on ${amount} for now.`
      );
  }
}
