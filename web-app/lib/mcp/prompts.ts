import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "daily_summary",
    {
      title: "Daily Summary",
      description:
        "Summarize all instrument activity for a given day, including run counts, failures, and system health.",
      argsSchema: {
        date: z
          .string()
          .optional()
          .describe("Date to summarize (YYYY-MM-DD). Defaults to today."),
      },
    },
    async ({ date }) => {
      const targetDate = date || new Date().toISOString().slice(0, 10);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Give me a summary of all lab instrument activity for ${targetDate}.`,
                "",
                "Steps:",
                `1. Call get_system_status to get an overview of all instruments and their watcher health.`,
                `2. Call search_runs with dateFrom="${targetDate}" and dateTo="${targetDate}" to find all runs from that day.`,
                `3. Summarize:`,
                `   - Total runs across all instruments`,
                `   - Breakdown by instrument`,
                `   - Any failed files or pending uploads`,
                `   - Watcher connectivity issues (offline or no_watcher)`,
                `   - Any anomalies or items needing attention`,
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "troubleshoot_instrument",
    {
      title: "Troubleshoot Instrument",
      description:
        "Diagnose connectivity or processing issues for an instrument by inspecting its status and watcher health.",
      argsSchema: {
        instrumentId: z
          .string()
          .describe("Instrument identifier to troubleshoot"),
      },
    },
    async ({ instrumentId }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Help me troubleshoot instrument "${instrumentId}".`,
                "",
                "Steps:",
                `1. Call get_instrument with instrumentId="${instrumentId}" to get its current status, watcher counts, and configuration.`,
                `2. Call list_watchers with instrumentId="${instrumentId}" to inspect each watcher's effective status and last heartbeat.`,
                `3. For each watcher surfaced in step 2, call get_watcher_heartbeats with its watcherId and hours=24 to inspect heartbeat gaps, error counts, and status changes over the last day.`,
                `4. Call search_runs with instrumentId="${instrumentId}", sort="created_at", order="desc", perPage=5 to check recent run activity.`,
                `5. Diagnose:`,
                `   - Is the instrument active or inactive?`,
                `   - Are any watchers online? If not, how long since the last heartbeat, and does the heartbeat history show an obvious point of failure?`,
                `   - Do the heartbeats report a rising error count or repeated upload failures?`,
                `   - Are there recent runs? If so, did they complete successfully or fail?`,
                `   - Are there files stuck in pending upload status?`,
                `   - Suggest concrete steps to resolve any issues found`,
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "compare_runs",
    {
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
    },
    async ({ instrumentId, runId1, runId2 }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Compare runs "${runId1}" and "${runId2}" on instrument "${instrumentId}".`,
                "",
                "Steps:",
                `1. Call get_run for both runs to get their metadata and timestamps.`,
                `2. Call list_run_files for both runs to see their files and processing status.`,
                `3. For any processed CSV files, call get_file_download_url to download and inspect the data.`,
                `4. Compare:`,
                `   - Experimental conditions (metadata differences)`,
                `   - Files and data types present in each run`,
                `   - Key measurement values and how they differ`,
                `   - Any data quality issues in either run (failed files, missing data)`,
                `   - Highlight significant differences and similarities`,
              ].join("\n"),
            },
          },
        ],
      };
    }
  );
}
