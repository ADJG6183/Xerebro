/**
 * Template explanation — the deterministic fallback path in
 * docs/AIArchitecture.md ("if the LLM is unavailable, ship the deterministic
 * recommendation with a template explanation"), and v1's ONLY path until the
 * LLM proxy milestone.
 *
 * Two substitution rules, both property-tested:
 *  - every money figure is formatted by code from the decision payload;
 *  - user-supplied text (the product description) can NEVER introduce a
 *    money figure — currency-like tokens are stripped before rendering.
 * This is the exact leash the LLM wears later, proven on templates first.
 */
import { formatMinor } from "../money";
import type { PurchaseDecision } from "../decision/purchaseApproval";
import type { VerificationResult } from "../verification/confidence";

/** Strip anything that could read as a money figure from user text. */
export function sanitizeDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const cleaned = description
    .replace(/\$\s*[\d.,]+/g, "") // "$999.99", "$ 1,200"
    .replace(/[\d.,]+\s*(?:dollars|bucks|usd)/gi, "") // "999 dollars"
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function renderTemplateExplanation(
  decision: PurchaseDecision,
  verification: VerificationResult,
): string {
  const { amountMinor, availableCashMinor, upcomingObligationsMinor, bufferFloorMinor } =
    decision.inputsSnapshot;
  const remaining = availableCashMinor - upcomingObligationsMinor - amountMinor;
  const amount = formatMinor(amountMinor);
  const product = sanitizeDescription(decision.inputsSnapshot.description);
  /** "the espresso machine ($600.00)" or just "$600.00". */
  const subject = product ? `the ${product} (${amount})` : amount;

  if (verification.status === "NEEDS_USER_INPUT") {
    return `I can't answer yet — I'm missing: ${verification.missingInputs.join(", ")}.`;
  }
  if (verification.status === "CANT_VERIFY") {
    // "Not established" (reconciliation never attempted, ADR-005: starts
    // unknown) and "stale data" are different problems with different fixes
    // — the first is NOT fixed by refreshing or reconnecting, so it must
    // not be phrased like a transient freshness issue (rocketMoneyMvpSpec.md
    // review: distinguish "update your bank" from "history verification
    // isn't established"). This checks the specific sentinel reason
    // verifyHighStakes uses for that exact case (confidence.ts) — a drift
    // FAILURE after reconciliation WAS attempted is a different, more
    // actionable situation and keeps the general phrasing below.
    if (verification.reason === "Bank balance reconciliation is not established yet") {
      return (
        `I can't give verified bank-backed guidance yet — your bank balance hasn't been ` +
        `matched against your transaction history, and refreshing or reconnecting won't change ` +
        `that by itself. Based on your last known data you would have ${formatMinor(remaining)} ` +
        `left after ${subject} and the next 30 days of bills — treat that as a sketch, not an answer.`
      );
    }
    const hours = Math.floor(verification.dataAgeSeconds / 3600);
    return (
      `I can't verify your balances right now (${verification.reason ?? "data unavailable"}). ` +
      `Based on data from ${hours}h ago you would have ${formatMinor(remaining)} left after ` +
      `${subject} and the next 30 days of bills — but treat that as a sketch, not an answer.`
    );
  }

  switch (decision.decision) {
    case "approve":
      return (
        `Yes — you can afford ${subject}. After it and ${formatMinor(upcomingObligationsMinor)} ` +
        `of upcoming bills, ${formatMinor(remaining)} stays available, above your ` +
        `${formatMinor(bufferFloorMinor)} buffer.`
      );
    case "caution":
      return (
        `You can cover ${subject}, but it cuts your cushion to ${formatMinor(remaining)} — ` +
        `below the ${formatMinor(bufferFloorMinor)} buffer you set. Doable, not comfortable.`
      );
    case "decline":
      return (
        `This would put you ${formatMinor(-remaining)} short of covering the next 30 days ` +
        `of bills. I'd hold off on ${subject} for now.`
      );
  }
}
