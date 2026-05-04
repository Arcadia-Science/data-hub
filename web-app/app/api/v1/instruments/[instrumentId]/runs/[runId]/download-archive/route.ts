import {
  fingerprintFiles,
  getArchiveDownloadFilename,
  getArchiveKey,
  invokeBuildArchive,
  isArchiveBuilderConfigured,
  type InvokeBuildArchiveInput,
} from "@/lib/api/archive-builder";
import { expireStaleArchiveJobs } from "@/lib/api/archive-jobs";
import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  INTERNAL_ERROR,
  NOT_FOUND,
  UNAUTHORIZED,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { archiveJobs, files } from "@/lib/db/schema";
import {
  getPresignedDownloadUrl,
  getS3ArchivesBucket,
  headS3Object,
} from "@/lib/s3";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { after } from "next/server";

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
// short-circuit to recover. We don't need to size this for sync builds —
// the route always goes async — but we still want a generous budget so
// transient Lambda transport errors get surfaced as terminal job failures
// rather than silent polling timeouts.
export const maxDuration = 300;

// Parse `?file_ids=1,2,3` (or repeated `?file_ids=1&file_ids=2`) into a
// deduped array of positive integers. Anything malformed is silently dropped
// so the request still resolves against whatever valid IDs were supplied.
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
  return ids.size > 0 ? Array.from(ids) : [];
}

type DownloadableFile = {
  id: number;
  filename: string;
  s3Bucket: string;
  s3Key: string;
};

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs/:runId/download-archive
//
// Returns a downloadable zip of every active, uploaded file in a run. The
// Lambda builder zips files from the raw + processed buckets directly into
// the archives bucket via S3 multipart upload, and this route 302s the
// browser to a short-lived presigned URL on the result — bytes never
// traverse Vercel.
//
// Cache hits short-circuit on an S3 HEAD against the canonical archive key
// and return immediately. Misses always go async: the route inserts an
// `archive_jobs` row, schedules the Lambda invocation via `after()`, and
// returns `202 { job_id }`. The UI polls this same URL — not
// `/api/v1/archive-jobs/:id` — so the cache-HEAD short-circuit is the
// canonical "is it ready?" signal regardless of whether the Lambda's PATCH
// callback to flip the row to `ready` ever lands.
//
// Optional `?file_ids=1,2,3` narrows the archive to a specific subset (used
// by the UI's "Download all" button to honor active table filters). IDs are
// always intersected with the run's own files, so callers can't reach files
// belonging to other runs. The fingerprint includes those IDs, so a filtered
// archive caches independently of a full-run archive.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  const fileIdsFilter = parseFileIdsParam(request.nextUrl.searchParams);

  const conditions = [
    eq(files.instrumentRunId, run.id),
    isNull(files.deletedAt),
  ];
  if (fileIdsFilter !== null) {
    if (fileIdsFilter.length === 0) {
      return apiError(404, NOT_FOUND, "No downloadable files for this run");
    }
    conditions.push(inArray(files.id, fileIdsFilter));
  }

  const fileRows = await db
    .select({
      id: files.id,
      filename: files.filename,
      s3Bucket: files.s3Bucket,
      s3Key: files.s3Key,
    })
    .from(files)
    .where(and(...conditions));

  const downloadable: DownloadableFile[] = fileRows
    .filter((f): f is DownloadableFile & { s3Bucket: string; s3Key: string } =>
      Boolean(f.s3Bucket && f.s3Key)
    )
    .map((f) => ({
      id: f.id,
      filename: f.filename,
      s3Bucket: f.s3Bucket,
      s3Key: f.s3Key,
    }));

  if (downloadable.length === 0) {
    return apiError(404, NOT_FOUND, "No downloadable files for this run");
  }

  return handleViaArchiveBuilder({
    request,
    instrumentId,
    runId,
    runInternalId: run.id,
    downloadable,
    createdBy: authResult.authMethod === "session" ? authResult.userId : null,
  });
}

// JS callers send `Accept: application/json` so they can poll async builds;
// direct browser navigation (e.g. a shared link) gets a 302.
function clientWantsJson(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

async function handleViaArchiveBuilder(args: {
  request: NextRequest;
  instrumentId: string;
  runId: string;
  runInternalId: string;
  downloadable: DownloadableFile[];
  createdBy: string | null;
}): Promise<Response> {
  const {
    request,
    instrumentId,
    runId,
    runInternalId,
    downloadable,
    createdBy,
  } = args;
  const wantsJson = clientWantsJson(request);

  // Bail early with 503 if the deploy is missing any of the env vars the
  // archive pipeline depends on (LAMBDA_FUNCTION_URL, LAMBDA_INVOKE_TOKEN,
  // S3_ARCHIVES_BUCKET). Without this, downstream calls like
  // `getS3ArchivesBucket()` and `invokeBuildArchive` would throw unhandled
  // and Vercel would surface an opaque 500 — and the async `after()`
  // callback would leave the row in `building` until the 20-minute stale
  // sweep noticed. Mirrors the pattern in `file-reprocessing.ts`.
  if (!isArchiveBuilderConfigured()) {
    return apiError(
      503,
      INTERNAL_ERROR,
      "Archive builder is not configured (LAMBDA_FUNCTION_URL, LAMBDA_INVOKE_TOKEN, and S3_ARCHIVES_BUCKET must all be set)"
    );
  }

  const fingerprint = fingerprintFiles(
    downloadable.map((f) => ({ id: f.id, s3Key: f.s3Key }))
  );
  const downloadFilename = getArchiveDownloadFilename(runId);
  const archiveBucket = getS3ArchivesBucket();
  const archiveKey = getArchiveKey(instrumentId, runId, fingerprint);

  // Cache hit: Lambda already produced a zip with the same fingerprint and
  // it hasn't aged past the 7 day lifecycle expiry. Skip the build entirely.
  const head = await headS3Object(archiveBucket, archiveKey);
  if (head.exists) {
    const url = await getPresignedDownloadUrl(archiveBucket, archiveKey, {
      filename: downloadFilename,
    });
    return wantsJson
      ? readyJsonResponse(url, head.sizeBytes)
      : redirectResponse(url);
  }

  // Files in a run can legitimately span the raw and processed buckets
  // (e.g. SpectraMax: raw `.xls` in the raw bucket + Lambda-produced CSV
  // in the processed bucket). The Lambda payload carries each file's
  // bucket per-entry and the Lambda enforces an allow-list against its
  // configured raw + processed env vars, so a stray row pointing at an
  // unexpected bucket fails closed at the builder, not here.

  // Heal any stuck row for this (run, fingerprint) before the dedup INSERT.
  // A Lambda that crashed mid-build leaves the row in `building` forever;
  // without this sweep the partial unique index keeps rejecting new inserts
  // and the user sees endless polling timeouts. See `archive-jobs.ts`.
  const expired = await expireStaleArchiveJobs(runInternalId, fingerprint);
  if (expired > 0) {
    console.warn(
      `Expired ${expired} stale archive_jobs row(s) for run ${runInternalId} (fingerprint ${fingerprint})`
    );
  }

  // Reuse an in-flight job for the same (run, fingerprint) so two
  // simultaneous clicks don't double-invoke the Lambda. The partial unique
  // index on archive_jobs handles the race: ON CONFLICT DO NOTHING returns
  // no row, we SELECT the existing one, and `weOwnBuild` tells us whether
  // *this* request is responsible for actually invoking the builder.
  const inserted = await db
    .insert(archiveJobs)
    .values({
      instrumentRunId: runInternalId,
      fingerprint,
      status: "building",
      archiveBucket,
      createdBy,
    })
    .onConflictDoNothing()
    .returning();

  let job = inserted[0];
  let weOwnBuild = job !== undefined;
  if (!job) {
    [job] = await db
      .select()
      .from(archiveJobs)
      .where(
        and(
          eq(archiveJobs.instrumentRunId, runInternalId),
          eq(archiveJobs.fingerprint, fingerprint),
          inArray(archiveJobs.status, ["pending", "building"])
        )
      )
      .limit(1);
  }

  if (!job) {
    // Partial unique index rejected the first INSERT but the SELECT found
    // no in-flight row — the prior job must have finished between those
    // two queries. Insert again (no conflict possible now since the
    // existing row is in a terminal state) and mark this request as the
    // owner of the new build.
    [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint,
        status: "building",
        archiveBucket,
        createdBy,
      })
      .returning();
    weOwnBuild = true;
  }

  // If we lost the race we MUST NOT invoke the Lambda — the existing build
  // will PATCH the row and write the same destination key, so kicking off
  // a parallel multipart upload would just double-spend Lambda + S3 PUT for
  // a byte-identical result. Fall through to the polling path so the UI
  // (or a JSON API caller) waits on the existing build instead.
  if (!weOwnBuild) {
    return buildingJsonResponse(job.id);
  }

  const buildInput: InvokeBuildArchiveInput = {
    jobId: job.id,
    instrumentId,
    runId,
    files: downloadable.map((f) => ({
      s3Key: f.s3Key,
      filename: f.filename,
      sourceBucket: f.s3Bucket,
    })),
  };

  // Every miss is async. The Lambda builder runs serially at ~100–150 MB/s
  // and we don't want a "Download all" click to block on a multi-minute
  // request — even small archives are dispatched here so the response time
  // is uniform and the UI is always driven by the same polling state
  // machine. `after()` returns the 202 to the client immediately and lets
  // the Lambda invocation complete in the function's tail lifecycle.
  after(() => runArchiveBuildInBackground(job.id, buildInput, fingerprint));
  return buildingJsonResponse(job.id);
}

// Fire-and-forget invocation used by the async path. The Lambda PATCHes the
// row to `ready` on success; we only need to mark `failed` if the invocation
// itself never reached the builder (transport error, 5xx, misconfig). This
// callback runs after the 202 response is flushed; if Vercel terminates the
// function before it completes, the Lambda's own failure-path PATCH still
// covers us.
//
// The outer try/catch is load-bearing: `invokeBuildArchive` throws when
// `LAMBDA_FUNCTION_URL` / `LAMBDA_INVOKE_TOKEN` are unset (or any other
// synchronous error happens before the fetch is dispatched). Without
// catching it, an `after()` exception leaves the row in `building` until
// `expireStaleArchiveJobs` notices 20 minutes later, and the user sees an
// indefinite spinner in the meantime.
async function runArchiveBuildInBackground(
  jobId: string,
  input: InvokeBuildArchiveInput,
  fingerprint: string
): Promise<void> {
  try {
    const result = await invokeBuildArchive(input, fingerprint);
    if (!result.ok) {
      await markJobFailed(jobId, result.message);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Archive builder invocation failed";
    console.error(
      `Archive builder threw while invoking Lambda for job ${jobId}:`,
      err
    );
    await markJobFailed(jobId, message).catch((dbErr) => {
      console.error(
        `Also failed to mark archive job ${jobId} as failed:`,
        dbErr
      );
    });
  }
}

async function markJobFailed(jobId: string, message: string): Promise<void> {
  await db
    .update(archiveJobs)
    .set({
      status: "failed",
      errorMessage: message,
      completedAt: new Date(),
    })
    .where(eq(archiveJobs.id, jobId));
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
      // Don't let intermediaries cache the 302 — the presigned URL inside
      // expires in 15 minutes, and a stale Location header would 403 the
      // user well after.
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
      // Same no-store rationale as the 302 — the embedded URL is short-lived.
      headers: { "Cache-Control": "no-store" },
    }
  );
}
