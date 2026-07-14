import { z } from "zod";
import type { McpPromptDef } from "@/lib/mcp/catalog/types";

export const dailySummaryPrompt = {
  name: "daily_summary",
  title: "Daily Summary",
  description:
    "Summarize all instrument activity for a given day, including run counts, failures, and system health.",
  argsSchema: {
    date: z
      .string()
      .optional()
      .describe("Date to summarize (YYYY-MM-DD). Defaults to today."),
  },
} as const satisfies McpPromptDef;

export const troubleshootInstrumentPrompt = {
  name: "troubleshoot_instrument",
  title: "Troubleshoot Instrument",
  description:
    "Diagnose connectivity or processing issues for an instrument by inspecting its status and watcher health.",
  argsSchema: {
    instrumentId: z.string().describe("Instrument identifier to troubleshoot"),
  },
} as const satisfies McpPromptDef;

export const compareRunsPrompt = {
  name: "compare_runs",
  title: "Compare Runs",
  description:
    "Compare the results of two runs side by side, highlighting differences in experimental outcomes.",
  argsSchema: {
    instrumentId: z
      .string()
      .describe(
        "Instrument identifier (both runs must be on the same instrument)"
      ),
    runId1: z.string().describe("First run identifier"),
    runId2: z.string().describe("Second run identifier"),
  },
} as const satisfies McpPromptDef;

export const findMyRunsPrompt = {
  name: "find_my_runs",
  title: "Find My Runs",
  description:
    "List runs claimed by the authenticated user, optionally scoped to an instrument and date range.",
  argsSchema: {
    instrumentId: z
      .string()
      .optional()
      .describe("Optional instrument to narrow results"),
    dateFrom: z
      .string()
      .optional()
      .describe("Start date (YYYY-MM-DD), inclusive"),
    dateTo: z.string().optional().describe("End date (YYYY-MM-DD), inclusive"),
  },
} as const satisfies McpPromptDef;

export const explainFailedRunPrompt = {
  name: "explain_failed_run",
  title: "Explain Failed Run",
  description:
    "Diagnose why a run failed and suggest reprocess or upload fixes.",
  argsSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
  },
} as const satisfies McpPromptDef;

export const claimUnattributedRunsPrompt = {
  name: "claim_unattributed_runs",
  title: "Claim Unattributed Runs",
  description:
    "Find unattributed runs on an instrument and claim them for the authenticated user after confirmation.",
  argsSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    dateFrom: z
      .string()
      .optional()
      .describe("Optional start date (YYYY-MM-DD)"),
    dateTo: z.string().optional().describe("Optional end date (YYYY-MM-DD)"),
  },
} as const satisfies McpPromptDef;

export const summarizeInstrumentWeekPrompt = {
  name: "summarize_instrument_week",
  title: "Summarize Instrument Week",
  description:
    "Summarize one instrument's activity over the last seven days (or a provided window).",
  argsSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    dateFrom: z
      .string()
      .optional()
      .describe("Start date (YYYY-MM-DD). Defaults to 7 days ago."),
    dateTo: z
      .string()
      .optional()
      .describe("End date (YYYY-MM-DD). Defaults to today."),
  },
} as const satisfies McpPromptDef;

export const MCP_PROMPT_DEFS = [
  dailySummaryPrompt,
  troubleshootInstrumentPrompt,
  compareRunsPrompt,
  findMyRunsPrompt,
  explainFailedRunPrompt,
  claimUnattributedRunsPrompt,
  summarizeInstrumentWeekPrompt,
] as const;
