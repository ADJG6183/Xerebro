/**
 * Copilot chat orchestration (docs/copilotArchitecture.md). The server holds
 * the event log and the shared engines, so tool execution — the math — runs
 * here; only the question and the COMPUTED aggregates ever reach the provider.
 *
 * Turn: route (LLM picks a tool) → execute (engine folds the log) → phrase
 * (LLM writes the answer from the result) → verify (faithfulness). Any failure
 * degrades to a deterministic template answer — the copilot never fabricates
 * and never goes silent.
 */
import {
  checkChatFaithful,
  dispatchTool,
  toolSchemas,
  ToolArgError,
  UnknownToolError,
  type EventEnvelope,
  type ToolResult,
} from "@xerebro/engines";
import type { LlmGateway } from "../llm/gateway";

export const CHAT_PROMPT_VERSION = "chat-v1";

export interface ChatAnswer {
  answer: string;
  /** Which tool ran; null when the question is out of scope. */
  tool: string | null;
  source: "llm" | "template" | "out_of_scope";
  /** The tool's computed data — the "based on your data" trace. */
  data?: Record<string, unknown>;
  model?: string;
}

const ROUTER_SYSTEM = [
  "You route a personal-finance question to exactly ONE tool that can answer it.",
  "Reply with ONLY a JSON object: {\"tool\": <name or null>, \"args\": {...}}.",
  "Pick null if no tool fits. Fill date args as YYYY-MM-DD using the given today.",
  "Never answer the question yourself — only route it.",
].join("\n");

const PHRASE_SYSTEM = [
  "You are a concise, friendly personal-finance assistant.",
  "Answer the question in 1-2 sentences using ONLY the data object provided.",
  "Copy every dollar amount EXACTLY as written. Never compute, estimate, or invent a number.",
  "Do not give financial advice; just report what the data shows.",
].join("\n");

interface Route {
  tool: string | null;
  args: Record<string, unknown>;
}

function parseRoute(text: string): Route {
  // Models sometimes wrap JSON in prose or fences; extract the first object.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { tool: null, args: {} };
  try {
    const parsed = JSON.parse(match[0]) as { tool?: unknown; args?: unknown };
    const tool = typeof parsed.tool === "string" ? parsed.tool : null;
    const args = parsed.args && typeof parsed.args === "object" ? (parsed.args as Record<string, unknown>) : {};
    return { tool, args };
  } catch {
    return { tool: null, args: {} };
  }
}

/** Deterministic fallback prose from a tool result — no LLM, always faithful. */
function templateAnswer(result: ToolResult): string {
  const d = result.data;
  switch (result.tool) {
    case "spend_total":
      return `You spent ${d.total} between ${d.fromDate} and ${d.toDate}${
        d.category && d.category !== "all" ? ` on ${String(d.category)}` : ""
      }.`;
    case "spend_by_category":
    case "top_categories": {
      const cats = (d.categories as { category: string; amount: string }[]) ?? [];
      if (cats.length === 0) return `No spending found between ${d.fromDate} and ${d.toDate}.`;
      return `Top spending: ${cats.map((c) => `${c.category} ${c.amount}`).join(", ")}.`;
    }
    case "financial_summary":
      return `You have ${d.availableCash} available cash and a net worth of ${d.netWorth}.`;
    case "bills_due": {
      const bills = (d.bills as { name: string; amount: string; due: string }[]) ?? [];
      if (bills.length === 0) return `No bills due in the next ${String(d.withinDays)} days.`;
      return `${d.total} in bills due soon: ${bills.map((b) => `${b.name} ${b.amount} (${b.due})`).join(", ")}.`;
    }
    default:
      return "Here's what your data shows.";
  }
}

const OUT_OF_SCOPE =
  "I can help with your spending, balances, net worth, and upcoming bills. Try asking about one of those.";

export async function answerQuestion(
  gateway: LlmGateway,
  input: { question: string; events: readonly EventEnvelope[]; todayLocal: string },
): Promise<ChatAnswer> {
  // 1. ROUTE — only the question + tool schemas + today leave to the provider.
  const routed = await gateway.complete({
    system: ROUTER_SYSTEM,
    user: JSON.stringify({ question: input.question, today: input.todayLocal, tools: toolSchemas() }),
  });
  const route = parseRoute(routed.text);
  if (route.tool === null) {
    return { answer: OUT_OF_SCOPE, tool: null, source: "out_of_scope" };
  }

  // 2. EXECUTE — the math, deterministically, on the server's event log.
  let result: ToolResult;
  try {
    result = dispatchTool(route.tool, input.events, route.args, { todayLocal: input.todayLocal });
  } catch (err) {
    if (err instanceof UnknownToolError || err instanceof ToolArgError) {
      return { answer: OUT_OF_SCOPE, tool: null, source: "out_of_scope" };
    }
    throw err;
  }

  // 3. PHRASE — only the COMPUTED aggregates leave to the provider.
  let phrased: { text: string; model: string };
  try {
    phrased = await gateway.complete({
      system: PHRASE_SYSTEM,
      user: JSON.stringify({ question: input.question, data: result.data }),
    });
  } catch {
    return { answer: withWarning(templateAnswer(result), result), tool: result.tool, source: "template", data: result.data };
  }

  // 4. VERIFY — every figure must be one the tool computed, else drop the prose.
  if (!checkChatFaithful(phrased.text, result.figures).faithful) {
    return { answer: withWarning(templateAnswer(result), result), tool: result.tool, source: "template", data: result.data };
  }

  return {
    answer: withWarning(phrased.text, result),
    tool: result.tool,
    source: "llm",
    data: result.data,
    model: phrased.model,
  };
}

function withWarning(answer: string, result: ToolResult): string {
  return typeof result.data.warning === "string" ? `${answer}\n\n${result.data.warning}` : answer;
}
