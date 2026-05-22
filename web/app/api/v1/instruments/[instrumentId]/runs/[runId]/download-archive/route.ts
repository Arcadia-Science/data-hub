import { authorize } from "@/lib/api/auth";
import { apiError, INTERNAL_ERROR, NOT_FOUND } from "@/lib/api/errors";
import { prepareRunArchive } from "@/lib/api/run-archive";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

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
  if (raw.length === 0) return null;
  const ids = new Set<number>();
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const n = Number.parseInt(part.trim(), 10);
      if (Number.isInteger(n) && n > 0) ids.add(n);
    }
  }
  return Array.from(ids);
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
// Optional `?file_ids=1,2,3` narrows the archive to a specific subset
// (used by the UI's "Download all" button to honor active table
// filters). IDs are intersected with the run's own files inside the
// helper, so callers can't reach files belonging to other runs. The
// fingerprint includes those IDs, so a filtered archive caches
// independently of a full-run archive.
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:read");
  if (authResult instanceof Response) return authResult;

  const { instrumentId, runId } = await params;

  const result = await prepareRunArchive({
    instrumentId,
    runId,
    fileIdsFilter: parseFileIdsParam(request.nextUrl.searchParams),
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
