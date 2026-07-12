/**
 * Copilot chat, client side. The transport POSTs the question to /chat; the
 * server does the routing, deterministic tool execution, and faithfulness
 * check (docs/copilotArchitecture.md). The app just presents the answer.
 */
export interface CopilotAnswer {
  answer: string;
  tool: string | null;
  source: "llm" | "template" | "out_of_scope";
  /** The tool's computed data — the "based on your data" trace. */
  data?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Assistant only: how the answer was produced. */
  source?: CopilotAnswer["source"];
  pending?: boolean;
}
