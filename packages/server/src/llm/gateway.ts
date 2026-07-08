/**
 * LLM gateway seam (docs/adr/ADR-002-stack.md: the proxy IS the provider
 * seam — swapping vendors is an adapter change plus an eval rerun).
 *
 * The OpenAI adapter is deliberately dumb: one non-streaming completion,
 * hard timeout, no retries (the caller's fallback is the template — retrying
 * a slow model just burns the perf budget; docs/performanceBudget.md).
 *
 * Zero-data-retention API terms are a launch prerequisite
 * (docs/SecurityPrivacy.md) — enforced contractually, not in code.
 */
export interface LlmGateway {
  complete(input: { system: string; user: string }): Promise<{ text: string; model: string }>;
}

export function openAiGateway(config: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): LlmGateway {
  return {
    async complete({ system, user }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 4_000);
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            max_tokens: 220,
            temperature: 0.4,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`openai HTTP ${res.status}`);
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          model?: string;
        };
        const text = body.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error("openai returned empty completion");
        return { text, model: body.model ?? config.model };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
