import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, INTERNAL_ERROR, NOT_FOUND } from "@/lib/api/errors";
import {
  type FilesCategoryFilter,
  type FilesLifecycleFilter,
  getFilteredFileIds,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import { prepareRunArchive } from "@/lib/api/run-archive";

const FILES_CATEGORY_VALUES: ReadonlySet<FilesCategoryFilter> = new Set([
  "raw",
  "processed",
]);

const FILES_STATUS_VALUES: ReadonlySet<FilesLifecycleFilter> = new Set([
  "pending",
  "uploaded",
  "processing",
  "completed",
  "failed",
]);

// Accepts comma-separated (`a,b`) or repeated (`a&key=b`) values; invalid
// entries are dropped so a partially-bad query still filters on the rest.
function parseListParam<T extends string>(
  searchParams: URLSearchParams,
  key: string,
  allowed: ReadonlySet<T>
): T[] {
  const values = new Set<T>();
  for (const entry of searchParams.getAll(key)) {
    for (const part of entry.split(",")) {
      const trimmed = part.trim();
      if (allowed.has(trimmed as T)) {
        values.add(trimmed as T);
      }
    }
  }
  return Array.from(values);
}

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// The route itself returns its 202 response in a couple of round-trips
// (cache HEAD, dedup INSERT), but the `after()` callback that POSTs the
// Lambda Function URL awaits the Lambda's synchronous response so we can
// log transport-level failures and mark the archive_jobs row `failed` for
// the dialog to surface. Builds shorter than this window land that
// callback cleanly; longer builds get the function killed and rely on the
// Lambda's own PATCH-on-failure path plus the polling client's S3 HEAD
// short-circuit to recover.
export const maxDuration = 300;

// Parse `?file_ids=1,2,3` (or repeated `?file_ids=1&file_ids=2`) into a
// deduped array of positive integers. Anything malformed is silently
// dropped so the request still resolves against whatever valid IDs were
// supplied. Returning `null` means "no filter"; an empty array means
// "filter requested but every entry was malformed" — the helper
// translates that into the same 404 a non-matching id list would.
function parseFileIdsParam(searchParams: URLSearchParams): number[] | null {
  const raw = searchParams.getAll("file_ids");
  if (raw.length === 0) {
    return null;
  }
  const ids = new Set<number>();
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const n = Number.parseInt(part.trim(), 10);
      if (Number.isInteger(n) && n > 0) {
        ids.add(n);
      }
    }
  }
  return Array.from(ids);
}

// Resolve the archive's file-id filter. An explicit `?file_ids=` always wins.
// Otherwise, the files table's active filters
// (`search`/`category`/`status`/`dismissed`) are resolved to the matching ids
// server-side so "Download all" honors the filter across every page —
// non-downloadable ids are dropped downstream by `loadDownloadableFiles`.
// With neither present we return `null` (the route's default "all
// downloadable files in the run" path).
async function resolveFileIdsFilter(
  request: NextRequest,
  instrumentId: string,
  runId: string
): Promise<number[] | null> {
  const explicit = parseFileIdsParam(request.nextUrl.searchParams);
  if (explicit !== null) {
    return explicit;
  }

  const sp = request.nextUrl.searchParams;
  const search = sp.get("search")?.trim() || undefined;
  const categories = parseListParam(sp, "category", FILES_CATEGORY_VALUES);
  const statuses = parseListParam(sp, "status", FILES_STATUS_VALUES);
  const includeDismissed = sp.get("dismissed") === "true";

  const hasFilter =
    search !== undefined ||
    categories.length > 0 ||
    statuses.length > 0 ||
    includeDismissed;
  if (!hasFilter) {
    return null;
  }

  // `lookupRunByNaturalKey` is request-cached, so this doesn't double the
  // lookup `prepareRunArchive` performs. A missing run falls through to the
  // 404 that helper raises.
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return null;
  }

  return getFilteredFileIds(run.id, {
    search,
    categories,
    statuses,
    includeDismissed,
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs/:runId/download-archive
//
// Returns a downloadable zip of every active, uploaded file in a run. The
// Lambda builder zips files from the raw + processed buckets directly
// into the archives bucket via S3 multipart upload, and this route 302s
// the browser to a short-lived presigned URL on the result — bytes never
// traverse Vercel.
//
// Cache hits short-circuit on an S3 HEAD against the canonical archive
// key and return immediately. Misses always go async: the helper inserts
// an `archive_jobs` row, schedules the Lambda invocation via `after()`,
// and the route returns `202 { job_id }`. The UI polls this same URL —
// not `/api/v1/archive-jobs/:id` — so the cache-HEAD short-circuit is
// the canonical "is it ready?" signal regardless of whether the Lambda's
// PATCH callback to flip the row to `ready` ever lands.
//
// Optional `?file_ids=1,2,3` narrows the archive to a specific subset. IDs
// are intersected with the run's own files inside the helper, so callers
// can't reach files belonging to other runs. The fingerprint includes those
// IDs, so a filtered archive caches independently of a full-run archive.
//
// Alternatively the UI's "Download all" button forwards the files table's
// active filters (`?search=`, `?category=`, `?status=`, `?dismissed=true`),
// which are resolved to the matching file ids server-side so the zip honors
// the filter across every page (not just the rows currently on screen).
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId } = await params;

  const result = await prepareRunArchive({
    instrumentId,
    runId,
    fileIdsFilter: await resolveFileIdsFilter(request, instrumentId, runId),
    createdBy: authResult.authMethod === "session" ? authResult.userId : null,
  });

  if (!result.ok) {
    const code = result.status === 503 ? INTERNAL_ERROR : NOT_FOUND;
    return apiError(result.status, code, result.message);
  }

  const wantsJson = clientWantsJson(request);

  if (result.status === "ready") {
    return wantsJson
      ? readyJsonResponse(result.downloadUrl, result.sizeBytes)
      : redirectResponse(result.downloadUrl);
  }

  return buildingJsonResponse(result.jobId);
}

// JS callers send `Accept: application/json` so they can poll async
// builds; direct browser navigation (e.g. a shared link) gets a 302.
function clientWantsJson(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

function buildingJsonResponse(jobId: string): Response {
  return Response.json(
    {
      job_id: jobId,
      status: "building",
    },
    {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    }
  );
}

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      // Don't let intermediaries cache the 302 — the presigned URL
      // expires in 15 minutes, and a stale Location header would 403
      // the user well after.
      "Cache-Control": "no-store",
    },
  });
}

function readyJsonResponse(url: string, sizeBytes: number | null): Response {
  return Response.json(
    {
      status: "ready",
      download_url: url,
      size_bytes: sizeBytes,
    },
    {
      // Same no-store rationale as the 302 — the embedded URL is
      // short-lived.
      headers: { "Cache-Control": "no-store" },
    }
  );
}
