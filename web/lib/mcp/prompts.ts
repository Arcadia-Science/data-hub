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
    ({ date }) => {
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
                "1. Call get_system_status to get an overview of all instruments and their watcher health.",
                `2. Call search_runs with dateFrom="${targetDate}" and dateTo="${targetDate}" to find all runs from that day.`,
                "3. Summarize:",
                "   - Total runs across all instruments",
                "   - Breakdown by instrument",
                "   - Any failed files or pending uploads",
                "   - Watcher connectivity issues (offline or no_watcher)",
                "   - Any anomalies or items needing attention",
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
    async ({ instrumentId }) => ({
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
              "3. For each watcher surfaced in step 2, call get_watcher_heartbeats with its watcherId and hours=24 to inspect heartbeat gaps, error counts, and status changes over the last day.",
              "4. For watchers that look unhealthy, call list_watcher_events with the same watcherId and hours=24 to inspect upload failures and errors.",
              `5. Call search_runs with instrumentId="${instrumentId}", sort="created_at", order="desc", perPage=5 to check recent run activity.`,
              "6. Diagnose:",
              "   - Is the instrument active or inactive?",
              "   - Are any watchers online? If not, how long since the last heartbeat, and does the heartbeat history show an obvious point of failure?",
              "   - Do the heartbeats report a rising error count or repeated upload failures?",
              "   - Are there recent runs? If so, did they complete successfully or fail?",
              "   - Are there files stuck in pending upload status?",
              "   - Suggest concrete steps to resolve any issues found",
            ].join("\n"),
          },
        },
      ],
    })
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
    async ({ instrumentId, runId1, runId2 }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Compare runs "${runId1}" and "${runId2}" on instrument "${instrumentId}".`,
              "",
              "Steps:",
              "1. Call get_run for both runs to get their metadata and timestamps.",
              "2. Call get_run_report for both runs to compare bounded processed-CSV samples, file counts, and failure summaries.",
              "3. Only call get_file_download_url if you need a file the report sample does not cover.",
              "4. Compare:",
              "   - Experimental conditions (metadata differences)",
              "   - Files and data types present in each run",
              "   - Key measurement values from the report samples and how they differ",
              "   - Any data quality issues in either run (failed files, missing data)",
              "   - Highlight significant differences and similarities",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "find_my_runs",
    {
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
        dateTo: z
          .string()
          .optional()
          .describe("End date (YYYY-MM-DD), inclusive"),
      },
    },
    ({ instrumentId, dateFrom, dateTo }) => {
      const filters = [
        'ranBy="me"',
        instrumentId ? `instrumentId="${instrumentId}"` : null,
        dateFrom ? `dateFrom="${dateFrom}"` : null,
        dateTo ? `dateTo="${dateTo}"` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Find runs I have claimed.",
                "",
                "Steps:",
                "1. Optionally call get_me to confirm the authenticated identity.",
                `2. Call search_runs with ${filters}.`,
                "3. Summarize run IDs, instruments, dates, and derived statuses. Flag failures or pending uploads.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "explain_failed_run",
    {
      title: "Explain Failed Run",
      description:
        "Diagnose why a run failed and suggest reprocess or upload fixes.",
      argsSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
    },
    async ({ instrumentId, runId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Explain why run "${runId}" on instrument "${instrumentId}" failed or looks unhealthy.`,
              "",
              "Steps:",
              `1. Call get_run with instrumentId="${instrumentId}", runId="${runId}", include=["failure_summary","files"].`,
              "2. Call get_run_report for the same run for processed-data context.",
              "3. Identify failed or stuck files (pending/uploaded/processing) and quote error messages.",
              "4. Recommend next actions: reprocess_run / reprocess_file, request_run_upload(_all) if pending and a watcher is online, or escalate watcher issues via list_watchers.",
              "5. Do not call destructive tools without confirming with the user first.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "claim_unattributed_runs",
    {
      title: "Claim Unattributed Runs",
      description:
        "Find unattributed runs on an instrument and claim them for the authenticated user after confirmation.",
      argsSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        dateFrom: z
          .string()
          .optional()
          .describe("Optional start date (YYYY-MM-DD)"),
        dateTo: z
          .string()
          .optional()
          .describe("Optional end date (YYYY-MM-DD)"),
      },
    },
    ({ instrumentId, dateFrom, dateTo }) => {
      const dateBits = [
        dateFrom ? `dateFrom="${dateFrom}"` : null,
        dateTo ? `dateTo="${dateTo}"` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Find unattributed runs on instrument "${instrumentId}" that I should claim.`,
                "",
                "Steps:",
                `1. Call search_runs with instrumentId="${instrumentId}", ranBy="unattributed"${dateBits ? `, ${dateBits}` : ""}.`,
                "2. Present the candidate run IDs and ask me to confirm which ones to claim (do not claim automatically).",
                "3. After confirmation, call claim_run for each approved run.",
                "4. Summarize what was claimed.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "summarize_instrument_week",
    {
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
    },
    ({ instrumentId, dateFrom, dateTo }) => {
      const today = new Date();
      const defaultTo = today.toISOString().slice(0, 10);
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const defaultFrom = weekAgo.toISOString().slice(0, 10);
      const from = dateFrom || defaultFrom;
      const to = dateTo || defaultTo;
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Summarize activity for instrument "${instrumentId}" from ${from} to ${to}.`,
                "",
                "Steps:",
                `1. Call get_instrument with instrumentId="${instrumentId}".`,
                `2. Call list_watchers with instrumentId="${instrumentId}" for watcher health.`,
                `3. Call search_runs with instrumentId="${instrumentId}", dateFrom="${from}", dateTo="${to}", perPage=100.`,
                "4. Summarize run volume, status breakdown, attributors, and any failures or pending uploads needing attention.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );
}
