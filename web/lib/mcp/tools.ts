import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getInstrumentSummaries, getUserById } from "@/lib/api/dashboard";
import { reprocessFile, reprocessRun } from "@/lib/api/file-reprocessing";
import {
  dismissFile,
  getActiveFileById,
  lookupFileForDownload,
} from "@/lib/api/files";
import {
  buildRunListQuery,
  getAttributionsByRunIds,
  getRanByFilterOptions,
  getRunFilesPage,
  lookupRunByNaturalKey,
  type RunFile,
} from "@/lib/api/instrument-runs";
import {
  getInstrumentById,
  getInstrumentListWithCounts,
} from "@/lib/api/instruments";
import { notifyComment } from "@/lib/api/notifications";
import { prepareRunArchive } from "@/lib/api/run-archive";
import {
  createComment,
  getCommentForAuthorCheck,
  listCommentsForRun,
  softDeleteComment,
  updateComment,
  validateCommentBody,
} from "@/lib/api/run-comments";
import { restoreRun, softDeleteRun } from "@/lib/api/run-lifecycle";
import { requestAllRunUploads, requestRunUploads } from "@/lib/api/run-uploads";
import { hasScope, type Scope } from "@/lib/api/scopes";
import { globalSearch } from "@/lib/api/search";
import { getWatcherHeartbeats, getWatcherList } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { runAttributions, users } from "@/lib/db/schema";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status";
import {
  getPresignedDownloadUrl,
  PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
} from "@/lib/s3";
import { MIN_QUERY_LENGTH } from "@/lib/search-constants";

// Sentinel for `search_runs.ranBy`: resolve to the authenticated PAT owner.
const RAN_BY_ME_SENTINEL = "me";

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

// Trim a file row to the fields useful to an LLM listing a run's files.
// Internal S3 location (`s3Bucket`/`s3Key`) and the potentially large
// `metadata` jsonb are intentionally dropped — callers that need full detail
// for a specific file use the `get_file` tool.
function toMcpFile(f: RunFile) {
  return {
    id: f.id,
    filename: f.filename,
    relativePath: f.relativePath,
    category: f.category,
    status: f.status,
    sizeBytes: f.sizeBytes,
    contentType: f.contentType,
    errorMessage: f.errorMessage,
    createdAt: f.createdAt,
    uploadedAt: f.uploadedAt,
    processedAt: f.processedAt,
  };
}

// Per-tool scope guard. Every MCP tool checks the same `<resource>:<action>`
// scope its REST counterpart enforces — there is no MCP-specific scope
// vocabulary, so a token with `runs:read` over REST also covers `search_runs`
// over MCP, and so on.
//
// When `authInfo` is undefined we skip the check: production traffic always
// has it (enforced by `withMcpAuth({ required: true })` in the route), and
// the in-memory test transport intentionally omits it. Letting unauthenticated
// callers through here keeps scope enforcement aligned with the HTTP
// boundary; downstream user-identity checks (e.g. `resolveAttributionTarget`)
// still reject the call when a user id is required.
function requireMcpScope(
  authInfo: AuthInfo | undefined,
  required: Scope
): ReturnType<typeof errorResult> | null {
  if (!authInfo) {
    return null;
  }
  if (hasScope({ scopes: authInfo.scopes ?? [] }, required)) {
    return null;
  }
  return errorResult(`Token is missing required scope: ${required}`);
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
    async ({ status }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "instruments:read");
      if (scopeError) {
        return scopeError;
      }
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
    async ({ instrumentId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "instruments:read");
      if (scopeError) {
        return scopeError;
      }
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
        "Search instrument runs with filtering, pagination, and sorting. Supports run status filters and instrument-metadata filters (plate reader, gel-doc, qPCR, Hina microscope, Epson scanner). Use global_search when the query may match filenames, instrument names, or attributor names rather than run IDs. Discover valid metadata filter values via the datahub://instruments/{id}/filter-options resource.",
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
          .describe("Search text matched against run ID only"),
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
        captureType: z
          .string()
          .optional()
          .describe("Gel-doc: filter by capture type"),
        imagingMode: z
          .string()
          .optional()
          .describe("Gel-doc: filter by imaging mode"),
        gelWavelength: z
          .string()
          .optional()
          .describe("Gel-doc: filter by wavelength"),
        gelColor: z.string().optional().describe("Gel-doc: filter by color"),
        dyeChannel: z
          .string()
          .optional()
          .describe("qPCR: filter by dye channel"),
        hinaChannel: z
          .string()
          .optional()
          .describe("Hina microscope: filter by channel name"),
        hinaDimension: z
          .string()
          .optional()
          .describe("Hina microscope: filter by dimension"),
        hinaSize: z
          .string()
          .optional()
          .describe(
            "Hina microscope: filter by sizes JSON object string (from filter-options)"
          ),
        dpi: z
          .string()
          .optional()
          .describe("Epson scanner: filter by DPI (e.g. '300')"),
        colorMode: z
          .string()
          .optional()
          .describe("Epson scanner: filter by color mode (e.g. 'rgb', 'bw')"),
        ranBy: z
          .string()
          .optional()
          .describe(
            'Filter by attributor. Pass a user id, the literal "me" for the authenticated token owner, or "unattributed" for runs with no attributions. Use get_me for your user id, or list_run_attributors to discover colleagues.'
          ),
        status: z
          .array(z.enum(RUN_STATUS_VALUES))
          .optional()
          .describe(
            "Filter by derived run status (OR'd together). Status is derived from a run's raw file states, priority-exclusive: failed (any file failed), pending (files awaiting upload), uploaded, processing, completed (all done), empty (no files)."
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }

      let ranBy = args.ranBy;
      if (ranBy === RAN_BY_ME_SENTINEL) {
        const userId = authInfo?.extra?.userId as string | undefined;
        if (!userId) {
          return errorResult(
            'ranBy="me" requires an authenticated user on this session. Use get_me to confirm identity, or pass a concrete user id.'
          );
        }
        ranBy = userId;
      }

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
        captureType: args.captureType,
        imagingMode: args.imagingMode,
        gelWavelength: args.gelWavelength,
        gelColor: args.gelColor,
        dyeChannel: args.dyeChannel,
        hinaChannel: args.hinaChannel,
        hinaDimension: args.hinaDimension,
        hinaSize: args.hinaSize,
        dpi: args.dpi,
        colorMode: args.colorMode,
        ranBy,
        statuses: args.status,
      });
      return textResult(result);
    }
  );

  server.registerTool(
    "global_search",
    {
      title: "Global Search",
      description:
        "Fuzzy search across runs, files, and instruments (same backend as the UI ⌘K palette). Prefer this over search_runs when the query may match a filename, instrument display name, or attributor name. Queries shorter than 2 characters return empty results.",
      inputSchema: {
        query: z.string().describe("Search query (min 2 characters)"),
        scope: z
          .enum(["all", "runs", "files", "instruments"])
          .optional()
          .describe("Limit results to one entity type (default: all)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, scope }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
      if (query.trim().length < MIN_QUERY_LENGTH) {
        return errorResult(
          `Query must be at least ${MIN_QUERY_LENGTH} characters.`
        );
      }
      const result = await globalSearch({
        query,
        scope: scope ?? "all",
      });
      return textResult(result);
    }
  );

  server.registerTool(
    "get_me",
    {
      title: "Get Me",
      description:
        'Return the authenticated PAT owner\'s identity (id, name, email, image, isAdmin). Use the returned id with search_runs ranBy=, or pass ranBy="me" instead.',
      annotations: { readOnlyHint: true },
    },
    async ({ authInfo }) => {
      const userId = authInfo?.extra?.userId as string | undefined;
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const user = await getUserById(userId);
      if (!user) {
        return errorResult(`User '${userId}' not found.`);
      }
      return textResult(user);
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
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
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
        "List files associated with a run (raw uploads and processed artifacts) with their status, category, and size. Paginated — runs can have thousands of files. Use the page/perPage arguments to walk the full list, and use get_file for full per-file detail including metadata and S3 location.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
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
          .describe("Results per page (default: 50, max: 100)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId, page, perPage }, { authInfo }) => {
      // The tool is keyed by run and the result is "what files belong to
      // this run", which lives under the runs domain in the REST API too
      // (`GET /instruments/:id/runs/:runId` returns files alongside the
      // run). One scope (`runs:read`) covers both.
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }
      const { data, pagination } = await getRunFilesPage(run.id, {
        page: page ?? 1,
        perPage: perPage ?? 50,
      });
      return textResult({ data: data.map(toMcpFile), pagination });
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
    // No inputSchema → the SDK passes the request `extra` as a single
    // argument; pull `authInfo` directly off it.
    async ({ authInfo }) => {
      // Dashboard summary keyed per-instrument; gated on `instruments:read`
      // for parity with the dashboard data source. Watcher health is
      // included for context but isn't the primary axis.
      const scopeError = requireMcpScope(authInfo, "instruments:read");
      if (scopeError) {
        return scopeError;
      }
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
    async ({ instrumentId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "watchers:read");
      if (scopeError) {
        return scopeError;
      }
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
    async ({ fileId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "files:read");
      if (scopeError) {
        return scopeError;
      }
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
    async ({ fileId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "files:read");
      if (scopeError) {
        return scopeError;
      }
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
        PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS
      );

      return textResult({
        fileId,
        filename: lookup.filename,
        downloadUrl,
        expiresInSeconds: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
      });
    }
  );

  server.registerTool(
    "get_run_archive",
    {
      title: "Get Run Archive",
      description:
        "Get a downloadable ZIP archive of every active, uploaded file in a run. " +
        "If the archive is already cached, returns a short-lived (15 min) pre-signed S3 URL the caller can fetch directly without auth — paste it into a browser or share it as a download link. " +
        "If the archive isn't cached, kicks off an async build and returns `{ status: 'building', jobId, retryAfterSeconds }`; call this tool again after the suggested wait to poll for completion. " +
        "Most archives finish in a few seconds; large runs may take a minute or two. Mirrors the REST `download-archive` route, including its dedup-by-fingerprint cache, so concurrent callers share a single Lambda invocation.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      // Mirror the REST archive route which is gated on `files:read`.
      const scopeError = requireMcpScope(authInfo, "files:read");
      if (scopeError) {
        return scopeError;
      }

      // Token-authenticated callers (every MCP request) don't have a
      // session user to record against `archive_jobs.created_by`, even
      // though the underlying user id is on `authInfo.extra`. Keep the
      // audit column NULL for parity with the watcher/Lambda paths and
      // to avoid a foreign-key surprise if the linked user is later
      // deleted.
      const result = await prepareRunArchive({
        instrumentId,
        runId,
        createdBy: null,
      });

      if (!result.ok) {
        return errorResult(result.message);
      }

      if (result.status === "ready") {
        return textResult({
          status: "ready",
          instrumentId,
          runId,
          downloadUrl: result.downloadUrl,
          filename: result.filename,
          sizeBytes: result.sizeBytes,
          expiresInSeconds: result.expiresInSeconds,
          contentType: "application/zip",
        });
      }

      return textResult({
        status: "building",
        instrumentId,
        runId,
        jobId: result.jobId,
        retryAfterSeconds: result.retryAfterSeconds,
        hint: "Call get_run_archive again after the suggested wait to retrieve the download URL.",
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
    async ({ fileId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "files:reprocess");
      if (scopeError) {
        return scopeError;
      }
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
    async ({ watcherId, hours }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "watchers:read");
      if (scopeError) {
        return scopeError;
      }
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
      const scopeError = requireMcpScope(authInfo, "runs:attribute");
      if (scopeError) {
        return scopeError;
      }
      const resolved = await resolveAttributionTarget(
        authInfo,
        instrumentId,
        runId
      );
      if (!resolved.ok) {
        return resolved.error;
      }

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
      const scopeError = requireMcpScope(authInfo, "runs:attribute");
      if (scopeError) {
        return scopeError;
      }
      const resolved = await resolveAttributionTarget(
        authInfo,
        instrumentId,
        runId
      );
      if (!resolved.ok) {
        return resolved.error;
      }

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
    async ({ instrumentId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
      const attributors = await getRanByFilterOptions(instrumentId);
      return textResult(attributors);
    }
  );

  server.registerTool(
    "list_run_comments",
    {
      title: "List Run Comments",
      description:
        "List comments on a run (oldest first), including author display info.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }
      const comments = await listCommentsForRun(run.id);
      return textResult({ comments });
    }
  );

  server.registerTool(
    "add_run_comment",
    {
      title: "Add Run Comment",
      description:
        "Add a comment on a run as the authenticated user. Author is taken from the token — you cannot comment as another user.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
        body: z.string().describe("Markdown comment body"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ instrumentId, runId, body }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:comment");
      if (scopeError) {
        return scopeError;
      }
      const userId = authInfo?.extra?.userId as string | undefined;
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const validated = validateCommentBody(body);
      if (!validated.ok) {
        return errorResult(validated.message);
      }
      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }
      if (run.deletedAt) {
        return errorResult("Cannot comment on a soft-deleted run.");
      }

      const comment = await createComment({
        runInternalId: run.id,
        userId,
        body: validated.body,
      });

      const [author] = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const authorDisplayName = author?.name ?? author?.email ?? "Someone";
      const origin = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : undefined;

      // In-app notifications still fire when `origin` is absent; Slack DMs that
      // need deep links are skipped (see `notifyComment`).
      void notifyComment({
        runInternalId: run.id,
        commentId: comment.id,
        authorUserId: userId,
        authorDisplayName,
        instrumentId,
        instrumentDisplayName: run.instrumentDisplayName,
        runDisplayId: runId,
        commentBody: validated.body,
        origin,
      });

      return textResult(comment);
    }
  );

  server.registerTool(
    "edit_run_comment",
    {
      title: "Edit Run Comment",
      description:
        "Edit one of your own comments. Returns an error if the comment is missing or authored by someone else.",
      inputSchema: {
        commentId: z.string().describe("Comment UUID"),
        body: z.string().describe("Updated markdown body"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ commentId, body }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:comment");
      if (scopeError) {
        return scopeError;
      }
      const userId = authInfo?.extra?.userId as string | undefined;
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const validated = validateCommentBody(body);
      if (!validated.ok) {
        return errorResult(validated.message);
      }

      const existing = await getCommentForAuthorCheck(commentId);
      if (!existing) {
        return errorResult(`Comment '${commentId}' not found.`);
      }
      if (existing.userId !== userId) {
        return errorResult("You can only edit your own comments.");
      }

      const updated = await updateComment({
        commentId,
        userId,
        body: validated.body,
      });
      if (!updated) {
        return errorResult(`Comment '${commentId}' not found.`);
      }
      return textResult(updated);
    }
  );

  server.registerTool(
    "delete_run_comment",
    {
      title: "Delete Run Comment",
      description:
        "Soft-delete one of your own comments. Idempotent if already deleted.",
      inputSchema: {
        commentId: z.string().describe("Comment UUID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ commentId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:comment");
      if (scopeError) {
        return scopeError;
      }
      const userId = authInfo?.extra?.userId as string | undefined;
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }

      const existing = await getCommentForAuthorCheck(commentId);
      if (!existing) {
        return errorResult(`Comment '${commentId}' not found.`);
      }
      if (existing.userId !== userId) {
        return errorResult("You can only delete your own comments.");
      }

      await softDeleteComment({ commentId, userId });
      return textResult({ id: commentId, deleted: true });
    }
  );

  server.registerTool(
    "reprocess_run",
    {
      title: "Reprocess Run",
      description:
        "Re-run Lambda processing for every completed or failed file on a run. Prefer this over looping reprocess_file for bulk retries after a parser fix.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:reprocess");
      if (scopeError) {
        return scopeError;
      }
      const result = await reprocessRun(instrumentId, runId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        filesQueued: result.filesQueued,
        filesFailed: result.filesFailed,
      });
    }
  );

  server.registerTool(
    "delete_run",
    {
      title: "Delete Run",
      description:
        "Soft-delete a run (sets deleted_at). Does not remove files or S3 objects. Use restore_run to undo.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:delete");
      if (scopeError) {
        return scopeError;
      }
      const userId = (authInfo?.extra?.userId as string | undefined) ?? null;
      const result = await softDeleteRun({
        instrumentId,
        runId,
        deletedBy: userId,
      });
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        deletedAt: result.deletedAt,
        deletedBy: result.deletedBy,
      });
    }
  );

  server.registerTool(
    "restore_run",
    {
      title: "Restore Run",
      description:
        "Restore a soft-deleted run by clearing deleted_at. No-op conflict if the run is not deleted.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:delete");
      if (scopeError) {
        return scopeError;
      }
      const result = await restoreRun(instrumentId, runId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        deletedAt: result.deletedAt,
      });
    }
  );

  server.registerTool(
    "request_run_upload",
    {
      title: "Request Run Upload",
      description:
        "Queue specific detected files for watcher upload (max 100). Requires an online watcher. Idempotent for files already in upload_requested.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
        fileIds: z
          .array(z.number().int())
          .min(1)
          .max(100)
          .describe("Numeric file IDs to queue"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ instrumentId, runId, fileIds }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:upload");
      if (scopeError) {
        return scopeError;
      }
      const result = await requestRunUploads({
        instrumentId,
        runId,
        fileIds,
      });
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        filesQueued: result.filesQueued,
        files: result.files,
      });
    }
  );

  server.registerTool(
    "request_run_upload_all",
    {
      title: "Request Run Upload All",
      description:
        "Queue every detected file on a run for watcher upload. Requires an online watcher.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument identifier"),
        runId: z.string().describe("Run identifier within the instrument"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ instrumentId, runId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "runs:upload");
      if (scopeError) {
        return scopeError;
      }
      const result = await requestAllRunUploads(instrumentId, runId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        instrumentId: result.instrumentId,
        runId: result.runId,
        filesQueued: result.filesQueued,
      });
    }
  );

  server.registerTool(
    "dismiss_file",
    {
      title: "Dismiss File",
      description:
        "Soft-delete a detected or upload_requested file (UI 'dismiss'). Uploaded files cannot be dismissed — delete the run instead.",
      inputSchema: {
        fileId: z.number().int().describe("Numeric file ID"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ fileId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "files:delete");
      if (scopeError) {
        return scopeError;
      }
      const result = await dismissFile(fileId);
      if (!result.ok) {
        return errorResult(result.message);
      }
      return textResult({
        id: result.id,
        filename: result.filename,
        deletedAt: result.deletedAt,
      });
    }
  );
}
