import { getInstrumentSummaries } from "@/lib/api/dashboard";
import {
  buildRunListQuery,
  getRunFiles,
  getRunReportData,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import {
  getInstrumentById,
  getInstrumentListWithCounts,
} from "@/lib/api/instruments";
import { getWatcherList } from "@/lib/api/watchers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "list_instruments",
    {
      title: "List Instruments",
      description:
        "List all registered lab instruments with run counts, watcher status, and file patterns. Optionally filter by status.",
      inputSchema: {
        status: z
          .enum(["pending", "active", "inactive"])
          .optional()
          .describe("Filter instruments by status"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      const instruments = await getInstrumentListWithCounts();
      const filtered = status
        ? instruments.filter((i) => i.status === status)
        : instruments;
      return textResult(filtered);
    }
  );

  server.registerTool(
    "get_instrument",
    {
      title: "Get Instrument",
      description:
        "Get detailed information about a specific instrument, including watcher online/offline counts and file patterns.",
      inputSchema: {
        instrumentId: z
          .string()
          .describe(
            "Kebab-case instrument identifier (e.g. 'spectramax-id3-plate-reader')"
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId }) => {
      const instrument = await getInstrumentById(instrumentId);
      if (!instrument) {
        return errorResult(`Instrument '${instrumentId}' not found.`);
      }
      return textResult(instrument);
    }
  );

  server.registerTool(
    "search_runs",
    {
      title: "Search Runs",
      description:
        "Search instrument runs with filtering, pagination, and sorting. Supports plate reader metadata filters (wavelength, measurement mode/type).",
      inputSchema: {
        instrumentId: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Filter to one or more instrument IDs"),
        source: z
          .enum(["lambda", "watcher"])
          .optional()
          .describe("Filter by run source"),
        search: z
          .string()
          .optional()
          .describe("Search text matched against run ID"),
        dateFrom: z
          .string()
          .optional()
          .describe("Start date (inclusive, YYYY-MM-DD)"),
        dateTo: z
          .string()
          .optional()
          .describe("End date (inclusive, YYYY-MM-DD)"),
        sort: z
          .enum(["created_at", "updated_at"])
          .optional()
          .describe("Sort field (default: created_at)"),
        order: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort order (default: desc)"),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Page number (default: 1)"),
        perPage: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Results per page (default: 20, max: 100)"),
        includeDeleted: z
          .boolean()
          .optional()
          .describe("Include soft-deleted runs (default: false)"),
        wavelength: z
          .string()
          .optional()
          .describe("Plate reader: filter by wavelength"),
        measurementMode: z
          .string()
          .optional()
          .describe("Plate reader: filter by measurement mode"),
        measurementType: z
          .string()
          .optional()
          .describe("Plate reader: filter by measurement type"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await buildRunListQuery({
        instrumentId: args.instrumentId,
        source: args.source,
        search: args.search,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        sort: args.sort,
        order: args.order,
        page: args.page ?? 1,
        perPage: args.perPage ?? 20,
        includeDeleted: args.includeDeleted ?? false,
        wavelength: args.wavelength,
        measurementMode: args.measurementMode,
        measurementType: args.measurementType,
      });
      return textResult(result);
    }
  );

  server.registerTool(
    "get_run",
    {
      title: "Get Run",
      description:
        "Get details for a specific instrument run by its natural key (instrument ID + run ID). Returns metadata, timestamps, and instrument info.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId }) => {
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }
      return textResult(run);
    }
  );

  server.registerTool(
    "get_run_report_data",
    {
      title: "Get Run Report Data",
      description:
        "Get structured report data for a run (plate maps, well data, kinetic data, spectrum data, etc.). This is the primary tool for accessing experimental results.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId }) => {
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }
      const reportData = await getRunReportData(run.id);
      return textResult(reportData);
    }
  );

  server.registerTool(
    "list_run_files",
    {
      title: "List Run Files",
      description:
        "List all files associated with a run, including raw uploads and processed artifacts with their status and metadata.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId }) => {
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }
      const files = await getRunFiles(run.id);
      return textResult(files);
    }
  );

  server.registerTool(
    "get_system_status",
    {
      title: "Get System Status",
      description:
        "Get a dashboard-level overview: per-instrument run counts, watcher health (online/offline/no_watcher), and pending upload counts.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const summaries = await getInstrumentSummaries();
      return textResult(summaries);
    }
  );

  server.registerTool(
    "list_watchers",
    {
      title: "List Watchers",
      description:
        "List all watcher agents with their effective status, hostname, instrument assignment, and last heartbeat time.",
      inputSchema: {
        instrumentId: z
          .string()
          .optional()
          .describe("Filter watchers to a specific instrument"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId }) => {
      const allWatchers = await getWatcherList({ includeDeleted: false });
      const filtered = instrumentId
        ? allWatchers.filter((w) => w.instrumentId === instrumentId)
        : allWatchers;
      return textResult(filtered);
    }
  );
}
