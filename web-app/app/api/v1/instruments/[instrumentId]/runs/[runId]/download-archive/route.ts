import {
  fingerprintFiles,
  getArchiveKey,
  getSyncArchiveThresholdBytes,
  invokeBuildArchive,
} from "@/lib/api/archive-builder";
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

// Vercel Pro's default function timeout is 15s, which is too short for any
// real sync build. The Lambda builder runs serially and sustains ~100–150
// MB/s in-region, so a fresh archive at the 25 GB sync ceiling takes ~3–4
// minutes of wall time. We give the route 5 minutes (Vercel Pro's hard max)
// so a fresh build right at `SYNC_ARCHIVE_THRESHOLD_GB` has a comfortable
// margin and the user gets a 302 instead of a timeout-then-cache-hit retry
// dance. Larger builds skip the inline await entirely (see
// `archive-builder.ts`), so this ceiling never bounds them.
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
  sizeBytes: number | null;
};

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs/:runId/download-archive
//
// Returns a downloadable zip of every active, uploaded file in a run. The
// Lambda builder zips files from the raw bucket directly into the archives
// bucket via S3 multipart upload, and this route 302s the browser to a
// short-lived presigned URL — bytes never traverse Vercel.
//
// Below `SYNC_ARCHIVE_THRESHOLD_GB` the route awaits the build inline; at or
// above the threshold it returns `202 { job_id }` so the UI can poll
// `GET /api/v1/archive-jobs/:id` and follow the redirect when ready.
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
      sizeBytes: files.sizeBytes,
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
      sizeBytes: f.sizeBytes,
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

  const fingerprint = fingerprintFiles(
    downloadable.map((f) => ({
      id: f.id,
      s3Key: f.s3Key,
      filename: f.filename,
    }))
  );
  const archiveBucket = getS3ArchivesBucket();
  const archiveKey = getArchiveKey(instrumentId, runId, fingerprint);

  // Cache hit: Lambda already produced a zip with the same fingerprint and
  // it hasn't aged past the 7 day lifecycle expiry. Skip the build entirely.
  const head = await headS3Object(archiveBucket, archiveKey);
  if (head.exists) {
    const url = await getPresignedDownloadUrl(archiveBucket, archiveKey);
    return wantsJson
      ? readyJsonResponse(url, head.sizeBytes)
      : redirectResponse(url);
  }

  const sourceBucket = downloadable[0].s3Bucket;
  // Belt-and-braces: every file in a run should live in the same bucket, but
  // if a stray legacy row points elsewhere, refusing the build is safer than
  // sending the wrong bucket to Lambda.
  for (const f of downloadable) {
    if (f.s3Bucket !== sourceBucket) {
      return apiError(
        500,
        INTERNAL_ERROR,
        "Run has files in multiple S3 buckets; archive builder cannot proceed"
      );
    }
  }

  const totalSize = estimateTotalSize(downloadable);
  const threshold = getSyncArchiveThresholdBytes();
  const goAsync = totalSize >= threshold;

  // Reuse an in-flight job for the same (run, fingerprint) so two simultaneous
  // clicks don't double-invoke the Lambda. The partial unique index on
  // archive_jobs handles the race: ON CONFLICT DO NOTHING returns no row, and
  // we then SELECT the existing one.
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
    // Index ruled out concurrent insert but no in-flight row remained — most
    // likely the prior job already finished. Fall through to async polling
    // by inserting a fresh row outside the inflight predicate.
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
  }

  if (goAsync) {
    after(async () => {
      const result = await invokeBuildArchive(
        {
          jobId: job.id,
          instrumentId,
          runId,
          sourceBucket,
          files: downloadable.map((f) => ({
            s3Key: f.s3Key,
            filename: f.filename,
          })),
        },
        fingerprint
      );
      if (!result.ok) {
        await db
          .update(archiveJobs)
          .set({
            status: "failed",
            errorMessage: result.message,
            completedAt: new Date(),
          })
          .where(eq(archiveJobs.id, job.id));
      }
      // The Lambda PATCH callback handles the success path so the row's
      // completed_at lines up with the actual upload finish time. We don't
      // mark `ready` here to avoid racing the callback.
    });
    return Response.json(
      {
        job_id: job.id,
        status: "building",
        poll_url: `/api/v1/archive-jobs/${job.id}`,
      },
      { status: 202 }
    );
  }

  const result = await invokeBuildArchive(
    {
      jobId: job.id,
      instrumentId,
      runId,
      sourceBucket,
      files: downloadable.map((f) => ({
        s3Key: f.s3Key,
        filename: f.filename,
      })),
    },
    fingerprint
  );

  if (!result.ok) {
    await db
      .update(archiveJobs)
      .set({
        status: "failed",
        errorMessage: result.message,
        completedAt: new Date(),
      })
      .where(eq(archiveJobs.id, job.id));
    return apiError(
      502,
      INTERNAL_ERROR,
      `Archive builder failed: ${result.message}`
    );
  }

  await db
    .update(archiveJobs)
    .set({
      status: "ready",
      archiveBucket: result.archiveBucket,
      archiveKey: result.archiveKey,
      sizeBytes: result.sizeBytes,
      completedAt: new Date(),
    })
    .where(eq(archiveJobs.id, job.id));

  const url = await getPresignedDownloadUrl(
    result.archiveBucket,
    result.archiveKey
  );
  return wantsJson
    ? readyJsonResponse(url, result.sizeBytes)
    : redirectResponse(url);
}

// Per-file fallback used to estimate archive size when `files.size_bytes` is
// NULL (legacy rows from before the column existed, or Lambda-created
// processed outputs that skipped recording size). 64 MB is comfortably above
// the typical processed artifact (CSVs, JSON, plot PNGs ≪ 5 MB) and small
// enough that even hundreds of unsized files don't push a normal run past the
// sync threshold. Tuning point: too low and we risk a sync timeout on a
// hidden whale; too high and we send legitimately small archives down the
// async polling path for no reason.
const UNKNOWN_SIZE_FALLBACK_BYTES = 64 * 1024 * 1024;

// Estimated total archive size in bytes. Files with NULL `size_bytes` get
// charged at `UNKNOWN_SIZE_FALLBACK_BYTES` so a single legacy row can't flip
// the entire request to the async polling UX. Going async when sync would
// have worked is harmless (extra dialog), but going sync on a true 100 GB
// build wastes a Vercel function — the Lambda still finishes regardless and
// the next click resolves from cache.
function estimateTotalSize(downloadable: DownloadableFile[]): number {
  let sum = 0;
  for (const f of downloadable) {
    sum += f.sizeBytes ?? UNKNOWN_SIZE_FALLBACK_BYTES;
  }
  return sum;
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
