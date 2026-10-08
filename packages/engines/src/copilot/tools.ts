/**
 * The copilot tool registry (docs/copilotArchitecture.md). Each tool is a
 * PURE function that folds the event log into a computed result. The LLM is
 * shown the schemas to route a question to a tool; it never runs the math.
 *
 * Every ToolResult carries `figures` — the exact minor-unit values the answer
 * is allowed to mention — which feeds checkChatFaithful. If a number isn't in
 * `figures`, the model invented it and the answer is rejected.
 */
import { formatMinor, type MinorUnits } from "../money";
import type { EventEnvelope } from "../events";
import { spendByCategory, spendTotal, topCategories } from "../queries/spending";
import { billsDue, financialSummary } from "../queries/summary";
import { buildSnapshot } from "../projection/snapshot";
import { historyReviewIssues } from "../projection/continuity";

export interface ToolContext {
  /** User's local "today" (YYYY-MM-DD) — engines never read a clock. */
  todayLocal: string;
}

export interface ToolResult {
  tool: string;
  /** Structured, human-readable data for the phrasing prompt (money as strings). */
  data: Record<string, unknown>;
  /** Minor-unit values the answer may mention — the faithfulness leash. */
  figures: MinorUnits[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** param name → what it means (shown to the router). */
  params: Record<string, string>;
  execute(events: readonly EventEnvelope[], args: Record<string, unknown>, ctx: ToolContext): ToolResult;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function requireDate(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ToolArgError(`${key} must be YYYY-MM-DD`);
  return v;
}

export class ToolArgError extends Error {}
export class UnknownToolError extends Error {}

export const TOOLS: ToolSpec[] = [
  {
    name: "spend_total",
    description: "Total amount spent in a date range, optionally within one category.",
    params: {
      fromDate: "start date YYYY-MM-DD (inclusive)",
      toDate: "end date YYYY-MM-DD (inclusive)",
      category: "optional category name to filter by",
    },
    execute(events, args, _ctx) {
      const fromDate = requireDate(args, "fromDate");
      const toDate = requireDate(args, "toDate");
      const category = str(args, "category");
      const total = spendTotal(events, { fromDate, toDate, ...(category ? { category } : {}) });
      return {
        tool: "spend_total",
        data: { fromDate, toDate, category: category ?? "all", total: formatMinor(total) },
        figures: [total],
      };
    },
  },
  {
    name: "spend_by_category",
    description: "Spending broken down by category over a date range, largest first.",
    params: {
      fromDate: "start date YYYY-MM-DD (inclusive)",
      toDate: "end date YYYY-MM-DD (inclusive)",
    },
    execute(events, args, _ctx) {
      const fromDate = requireDate(args, "fromDate");
      const toDate = requireDate(args, "toDate");
      const rows = spendByCategory(events, { fromDate, toDate });
      return {
        tool: "spend_by_category",
        data: {
          fromDate,
          toDate,
          categories: rows.map((r) => ({ category: r.category, amount: formatMinor(r.totalMinor) })),
        },
        figures: rows.map((r) => r.totalMinor),
      };
    },
  },
  {
    name: "top_categories",
    description: "The largest N spending categories in a date range.",
    params: {
      fromDate: "start date YYYY-MM-DD (inclusive)",
      toDate: "end date YYYY-MM-DD (inclusive)",
      limit: "how many categories (default 3)",
    },
    execute(events, args, _ctx) {
      const fromDate = requireDate(args, "fromDate");
      const toDate = requireDate(args, "toDate");
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const rows = topCategories(events, { fromDate, toDate, ...(limit ? { limit } : {}) });
      return {
        tool: "top_categories",
        data: {
          fromDate,
          toDate,
          categories: rows.map((r) => ({ category: r.category, amount: formatMinor(r.totalMinor) })),
        },
        figures: rows.map((r) => r.totalMinor),
      };
    },
  },
  {
    name: "financial_summary",
    description: "Current available cash and net worth. Use for balance / net-worth questions.",
    params: {},
    execute(events, _args, ctx) {
      const s = financialSummary(events, ctx.todayLocal);
      return {
        tool: "financial_summary",
        data: {
          availableCash: formatMinor(s.availableCashMinor),
          netWorth: formatMinor(s.netWorthMinor),
          ...(s.excludedAccountIds.length > 0
            ? { warning: `${s.excludedAccountIds.length} account(s) excluded because their USD value is unknown` }
            : {}),
        },
        figures: [s.availableCashMinor, s.netWorthMinor],
      };
    },
  },
  {
    name: "bills_due",
    description: "Upcoming bills due within a number of days (default 30).",
    params: { withinDays: "how many days ahead to look (default 30)" },
    execute(events, args, ctx) {
      const withinDays = typeof args.withinDays === "number" ? args.withinDays : 30;
      const result = billsDue(events, { today: ctx.todayLocal, withinDays });
      return {
        tool: "bills_due",
        data: {
          withinDays,
          total: formatMinor(result.totalMinor),
          bills: result.items.map((b) => ({
            name: b.name,
            amount: formatMinor(b.amountMinor),
            due: b.nextDue,
          })),
        },
        figures: [result.totalMinor, ...result.items.map((b) => b.amountMinor)],
      };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The registry as the router sees it — names, descriptions, params. */
export function toolSchemas(): { name: string; description: string; params: Record<string, string> }[] {
  return TOOLS.map(({ name, description, params }) => ({ name, description, params }));
}

/** Execute a routed tool. Throws UnknownToolError / ToolArgError on bad input. */
export function dispatchTool(
  toolName: string,
  events: readonly EventEnvelope[],
  args: Record<string, unknown>,
  ctx: ToolContext,
): ToolResult {
  const tool = BY_NAME.get(toolName);
  if (!tool) throw new UnknownToolError(`unknown tool: ${toolName}`);
  const result = tool.execute(events, args ?? {}, ctx);
  const warnings = historyReviewIssues(buildSnapshot(events).transactions);
  if (warnings.length) result.data.warning = [result.data.warning, ...warnings].filter(Boolean).join(". ");
  return result;
}
