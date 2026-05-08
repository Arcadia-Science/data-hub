import { getInstrumentSummaries } from "@/lib/api/dashboard";
import { reprocessFile } from "@/lib/api/file-reprocessing";
import {
  countDownloadableRunFiles,
  getActiveFileById,
  lookupFileForDownload,
} from "@/lib/api/files";
import {
  buildRunListQuery,
  getAttributionsByRunIds,
  getRanByFilterOptions,
  getRunFiles,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import {
  getInstrumentById,
  getInstrumentListWithCounts,
} from "@/lib/api/instruments";
import { getWatcherHeartbeats, getWatcherList } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { runAttributions } from "@/lib/db/schema";
import { getPresignedDownloadUrl } from "@/lib/s3";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

// Pre-signed URLs issued via the MCP server use the same default window as
// the REST download route (15 minutes). Exposed in the tool response so
// clients know how long the link remains valid.
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 15 * 60;

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

type AttributionResolution =
  | { ok: true; userId: string; runUuid: string }
  | { ok: false; error: ReturnType<typeof errorResult> };

// Shared resolution step for claim_run / unclaim_run. The authenticated user
// id is pulled only from authInfo — never from an argument — to preserve the
// "no spoofable user id" invariant the REST route at
// /api/v1/instruments/:instrumentId/runs/:runId/attributions/me enforces.
async function resolveAttributionTarget(
  authInfo: AuthInfo | undefined,
  instrumentId: string,
  runId: string
): Promise<AttributionResolution> {
  const userId = authInfo?.extra?.userId as string | undefined;
  if (!userId) {
    return {
      ok: false,
      error: errorResult("Authenticated user not available on this session."),
    };
  }
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return {
      ok: false,
      error: errorResult(
        `Run '${runId}' not found for instrument '${instrumentId}'.`
      ),
    };
  }
  return { ok: true, userId, runUuid: run.id };
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
          .enum(["acquired_at", "created_at", "updated_at"])
          .optional()
          .describe(
            "Sort field (default: acquired_at — when the run actually happened on the instrument PC, falling back to created_at)"
          ),
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
        ranBy: z
          .string()
          .optional()
          .describe(
            'Filter by attributor. Pass a user id to match runs attributed to that user, or the literal "unattributed" to match runs with no attributions. Use list_run_attributors to discover valid user ids.'
          ),
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
        ranBy: args.ranBy,
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

  server.registerTool(
    "get_file",
    {
      title: "Get File",
      description:
        "Get detailed metadata for a single file by its numeric ID, including status, S3 location, size, extracted metadata, and any error message.",
      inputSchema: {
        fileId: z.number().int().describe("Numeric file ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }) => {
      const file = await getActiveFileById(fileId);
      if (!file) {
        return errorResult(`File '${fileId}' not found.`);
      }
      return textResult(file);
    }
  );

  server.registerTool(
    "get_file_download_url",
    {
      title: "Get File Download URL",
      description:
        "Get a short-lived pre-signed S3 URL to download the raw file contents. URL expires after 15 minutes.",
      inputSchema: {
        fileId: z.number().int().describe("Numeric file ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }) => {
      const lookup = await lookupFileForDownload(fileId);
      if (!lookup.ok) {
        if (lookup.reason === "not_uploaded") {
          return errorResult(
            `File '${fileId}' has not been uploaded to S3 yet.`
          );
        }
        return errorResult(`File '${fileId}' not found.`);
      }

      const downloadUrl = await getPresignedDownloadUrl(
        lookup.s3Bucket,
        lookup.s3Key,
        DOWNLOAD_URL_EXPIRES_IN_SECONDS
      );

      return textResult({
        fileId,
        filename: lookup.filename,
        downloadUrl,
        expiresInSeconds: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
      });
    }
  );

  server.registerTool(
    "get_run_archive_path",
    {
      title: "Get Run Archive Path",
      description:
        "Get an API path that streams a ZIP archive of all active, uploaded files for a run. The returned path is relative to the Data Hub API host — prepend the Data Hub origin to produce a full URL. Unlike get_file_download_url, the archive endpoint requires the same Bearer token the client used for this MCP session; the path cannot be fetched anonymously.",
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

      // Mirror the preflight check in the download-archive route so callers
      // get a clear error instead of a 404 from the ZIP stream. The archive
      // route only includes files that have actually been uploaded to S3.
      const count = await countDownloadableRunFiles(run.id);
      if (count === 0) {
        return errorResult(
          `Run '${runId}' has no downloadable files to archive.`
        );
      }

      const archivePath = `/api/v1/instruments/${encodeURIComponent(
        instrumentId
      )}/runs/${encodeURIComponent(runId)}/download-archive`;

      return textResult({
        instrumentId,
        runId,
        archivePath,
        contentType: "application/zip",
      });
    }
  );

  server.registerTool(
    "reprocess_file",
    {
      title: "Reprocess File",
      description:
        "Re-run the Lambda processing workflow for a failed or completed file. Transitions the file back to 'processing'. Use this to retry after a parser fix or transient Lambda failure.",
      inputSchema: {
        fileId: z.number().int().describe("Numeric file ID"),
      },
      // destructiveHint is true because the tool resets status/errorMessage/
      // processedAt. The Lambda re-processes the file, but the mutation is
      // irreversible from the tool's perspective and clients should confirm.
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ fileId }) => {
      const result = await reprocessFile(fileId);
      if (!result.ok) {
        return errorResult(`[${result.code}] ${result.message}`);
      }
      return textResult({ status: "processing", fileId: result.fileId });
    }
  );

  server.registerTool(
    "get_watcher_heartbeats",
    {
      title: "Get Watcher Heartbeats",
      description:
        "Get recent heartbeat history for a watcher agent, useful for diagnosing connectivity gaps and error trends. Returns up to 100 most recent heartbeats within the lookback window.",
      inputSchema: {
        watcherId: z.string().describe("Watcher UUID"),
        hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe("Lookback window in hours (default: 24, max: 168)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ watcherId, hours }) => {
      const lookbackHours = hours ?? 24;
      const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
      const { rows, total } = await getWatcherHeartbeats(watcherId, {
        since,
        page: 1,
        pageSize: 100,
      });
      return textResult({
        watcherId,
        sinceIso: since.toISOString(),
        lookbackHours,
        total,
        heartbeats: rows,
      });
    }
  );

  server.registerTool(
    "claim_run",
    {
      title: "Claim Run",
      description:
        "Mark a run as performed by the authenticated user. Idempotent — claiming a run you already claimed is a no-op. Only self-attribution is supported; you cannot claim a run on behalf of another user.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const resolved = await resolveAttributionTarget(
        authInfo,
        instrumentId,
        runId
      );
      if (!resolved.ok) return resolved.error;

      await db
        .insert(runAttributions)
        .values({ runId: resolved.runUuid, userId: resolved.userId })
        .onConflictDoNothing();

      const byRun = await getAttributionsByRunIds([resolved.runUuid]);
      return textResult({
        instrumentId,
        runId,
        attributions: byRun.get(resolved.runUuid) ?? [],
      });
    }
  );

  server.registerTool(
    "unclaim_run",
    {
      title: "Unclaim Run",
      description:
        "Remove the authenticated user's attribution from a run. Idempotent — unclaiming a run you don't currently claim is a no-op. Only self-attribution is supported; you cannot remove another user's attribution.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      // destructiveHint because removing an attribution is user-visible across
      // dashboards and the runs table; clients should confirm before calling.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const resolved = await resolveAttributionTarget(
        authInfo,
        instrumentId,
        runId
      );
      if (!resolved.ok) return resolved.error;

      await db
        .delete(runAttributions)
        .where(
          and(
            eq(runAttributions.runId, resolved.runUuid),
            eq(runAttributions.userId, resolved.userId)
          )
        );

      const byRun = await getAttributionsByRunIds([resolved.runUuid]);
      return textResult({
        instrumentId,
        runId,
        attributions: byRun.get(resolved.runUuid) ?? [],
      });
    }
  );

  server.registerTool(
    "list_run_attributors",
    {
      title: "List Run Attributors",
      description:
        "List distinct users who have claimed at least one run on a given instrument. Use the returned userId with search_runs ranBy=<userId>.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId }) => {
      const attributors = await getRanByFilterOptions(instrumentId);
      return textResult(attributors);
    }
  );
}
