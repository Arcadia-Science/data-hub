import { and, eq, inArray, isNull } from "drizzle-orm";
import { after } from "next/server";
import {
  fingerprintFiles,
  getArchiveDownloadFilename,
  getArchiveKey,
  type InvokeBuildArchiveInput,
  invokeBuildArchive,
  isArchiveBuilderConfigured,
} from "@/lib/api/archive-builder";
import { expireStaleArchiveJobs } from "@/lib/api/archive-jobs";
import { estimateRetryAfterSeconds } from "@/lib/api/archive-retry";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { archiveJobs, files } from "@/lib/db/schema";
import {
  getPresignedDownloadUrl,
  getS3ArchivesBucket,
  headS3Object,
  PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
} from "@/lib/s3";

export interface DownloadableFile {
  filename: string;
  id: number;
  s3Bucket: string;
  s3Key: string;
  // Nullable: older rows and not-yet-sized uploads can lack a size. Used only
  // to estimate the build-time retry hint and to let the builder decide
  // prefetch eligibility — never required for correctness.
  sizeBytes: number | null;
}

export interface PrepareRunArchiveInput {
  // User who triggered this build, for the `archive_jobs.created_by`
  // audit column. Should be `null` for token-authenticated callers
  // (Lambda, MCP, watcher) since the column references `users.id`.
  createdBy: string | null;
  // Subset of file IDs to include. `null` means "every uploaded file in
  // the run", which matches the default "Download all" behavior. An empty
  // array means the caller asked for a specific subset and supplied none
  // of the run's files; we surface that as a clear error.
  fileIdsFilter?: number[] | null;
  instrumentId: string;
  runId: string;
}

export type PrepareRunArchiveResult =
  | {
      ok: false;
      // Mirrors the HTTP status the REST route would return. The MCP layer
      // doesn't surface status codes directly but uses 503 / 404 to
      // disambiguate user-actionable errors from configuration drift.
      status: 404 | 503;
      message: string;
    }
  | {
      ok: true;
      status: "ready";
      // Pre-signed S3 URL the browser can fetch directly without auth.
      // Carries `Content-Disposition: attachment; filename="<runId>.zip"`
      // so the saved file matches the run id.
      downloadUrl: string;
      sizeBytes: number | null;
      filename: string;
      expiresInSeconds: number;
      archiveBucket: string;
      archiveKey: string;
    }
  | {
      ok: true;
      status: "building";
      jobId: string;
      // True when this call kicked off the Lambda invocation (vs. joining
      // an in-flight build started by another request). Useful for
      // logging; clients shouldn't branch on it.
      ownsBuild: boolean;
      retryAfterSeconds: number;
    };

// ---------------------------------------------------------------------------
// Resolves a run + file set into either a ready pre-signed download URL
// (cache hit) or an in-flight build job (cache miss). Shared between the
// REST `download-archive` route and the MCP `get_run_archive` tool so both
// surfaces honor the same dedup, fingerprint, and Lambda-invocation rules.
//
// The function never throws on "user-actionable" errors (no run, no files,
// not configured); those come back as `{ ok: false, status, message }`.
// Programming errors (DB outage, S3 transport failure outside HEAD) still
// propagate so the caller's request fails loudly.
// ---------------------------------------------------------------------------
export async function prepareRunArchive(
  input: PrepareRunArchiveInput
): Promise<PrepareRunArchiveResult> {
  if (!isArchiveBuilderConfigured()) {
    return {
      ok: false,
      status: 503,
      message:
        "Archive builder is not configured (LAMBDA_FUNCTION_URL, S3_ARCHIVES_BUCKET, and AWS credentials must all be set)",
    };
  }

  const run = await lookupRunByNaturalKey(input.instrumentId, input.runId);
  if (!run) {
    return {
      ok: false,
      status: 404,
      message: `Run '${input.runId}' not found for instrument '${input.instrumentId}'`,
    };
  }

  const fileIdsFilter = input.fileIdsFilter ?? null;
  if (fileIdsFilter !== null && fileIdsFilter.length === 0) {
    return {
      ok: false,
      status: 404,
      message: "No downloadable files for this run",
    };
  }

  const downloadable = await loadDownloadableFiles(run.id, fileIdsFilter);
  if (downloadable.length === 0) {
    return {
      ok: false,
      status: 404,
      message: "No downloadable files for this run",
    };
  }

  const fingerprint = fingerprintFiles(
    downloadable.map((f) => ({ id: f.id, s3Key: f.s3Key }))
  );
  const archiveBucket = getS3ArchivesBucket();
  const archiveKey = getArchiveKey(
    input.instrumentId,
    input.runId,
    fingerprint
  );
  const filename = getArchiveDownloadFilename(input.runId);

  // Cache hit: Lambda already produced a zip with this fingerprint and
  // the lifecycle-policy hasn't expired it. Skip the build entirely and
  // return a presigned URL that's safe to hand to a browser (or paste
  // into a chat client).
  const head = await headS3Object(archiveBucket, archiveKey);
  if (head.exists) {
    const downloadUrl = await getPresignedDownloadUrl(
      archiveBucket,
      archiveKey,
      {
        filename,
        expiresIn: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
      }
    );
    return {
      ok: true,
      status: "ready",
      downloadUrl,
      sizeBytes: head.sizeBytes,
      filename,
      expiresInSeconds: PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS,
      archiveBucket,
      archiveKey,
    };
  }

  // Cache miss → reuse an in-flight job for the same (run, fingerprint)
  // if one exists, else insert a fresh row and kick off the Lambda.
  // First sweep stale rows so a crashed prior build doesn't deadlock the
  // partial unique index (see expireStaleArchiveJobs).
  const expired = await expireStaleArchiveJobs(run.id, fingerprint);
  if (expired > 0) {
    console.warn(
      `Expired ${expired} stale archive_jobs row(s) for run ${run.id} (fingerprint ${fingerprint})`
    );
  }

  const { job, ownsBuild } = await ensureArchiveJob({
    runInternalId: run.id,
    fingerprint,
    archiveBucket,
    createdBy: input.createdBy,
  });

  if (ownsBuild) {
    // Fire-and-forget Lambda invocation. `after()` returns immediately so
    // the caller (REST 202 / MCP "building" response) doesn't block on the
    // build, but the function context stays alive long enough to record a
    // failure in `archive_jobs` if the invocation never reaches the builder.
    const buildInput: InvokeBuildArchiveInput = {
      jobId: job.id,
      instrumentId: input.instrumentId,
      runId: input.runId,
      files: downloadable.map((f) => ({
        s3Key: f.s3Key,
        filename: f.filename,
        sourceBucket: f.s3Bucket,
        sizeBytes: f.sizeBytes,
      })),
    };
    after(() => runArchiveBuildInBackground(job.id, buildInput, fingerprint));
  }

  const totalBytes = downloadable.reduce(
    (sum, f) => sum + (f.sizeBytes ?? 0),
    0
  );
  return {
    ok: true,
    status: "building",
    jobId: job.id,
    ownsBuild,
    retryAfterSeconds: estimateRetryAfterSeconds({
      fileCount: downloadable.length,
      totalBytes,
    }),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadDownloadableFiles(
  runInternalId: string,
  fileIdsFilter: number[] | null
): Promise<DownloadableFile[]> {
  const conditions = [
    eq(files.instrumentRunId, runInternalId),
    isNull(files.deletedAt),
  ];
  if (fileIdsFilter !== null) {
    conditions.push(inArray(files.id, fileIdsFilter));
  }

  const rows = await db
    .select({
      id: files.id,
      filename: files.filename,
      s3Bucket: files.s3Bucket,
      s3Key: files.s3Key,
      sizeBytes: files.sizeBytes,
    })
    .from(files)
    .where(and(...conditions));

  return rows
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
}

interface EnsureArchiveJobInput {
  archiveBucket: string;
  createdBy: string | null;
  fingerprint: string;
  runInternalId: string;
}

interface EnsureArchiveJobResult {
  job: typeof archiveJobs.$inferSelect;
  ownsBuild: boolean;
}

// Inserts a fresh in-flight job for (run, fingerprint), or — if another
// request beat us to it — selects the existing one. The partial unique
// index on `archive_jobs (run, fingerprint) WHERE status in
// ('pending','building')` makes the INSERT racefully idempotent.
//
// `ownsBuild` is true iff *this* call performed the INSERT (and is
// therefore responsible for invoking the Lambda). Joiners must NOT
// re-invoke; the existing build will write the same destination key.
async function ensureArchiveJob(
  input: EnsureArchiveJobInput
): Promise<EnsureArchiveJobResult> {
  const inserted = await db
    .insert(archiveJobs)
    .values({
      instrumentRunId: input.runInternalId,
      fingerprint: input.fingerprint,
      status: "building",
      archiveBucket: input.archiveBucket,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    return { job: inserted[0], ownsBuild: true };
  }

  const [existing] = await db
    .select()
    .from(archiveJobs)
    .where(
      and(
        eq(archiveJobs.instrumentRunId, input.runInternalId),
        eq(archiveJobs.fingerprint, input.fingerprint),
        inArray(archiveJobs.status, ["pending", "building"])
      )
    )
    .limit(1);

  if (existing) {
    return { job: existing, ownsBuild: false };
  }

  // Partial unique index rejected the first INSERT but the SELECT found
  // no in-flight row — the prior job must have transitioned to a terminal
  // state between the two queries. Insert again (no conflict possible now)
  // and mark this request as the owner.
  const [retry] = await db
    .insert(archiveJobs)
    .values({
      instrumentRunId: input.runInternalId,
      fingerprint: input.fingerprint,
      status: "building",
      archiveBucket: input.archiveBucket,
      createdBy: input.createdBy,
    })
    .returning();
  return { job: retry, ownsBuild: true };
}

// Fire-and-forget Lambda invoker used by the `after()` callback. The
// builder PATCHes `archive_jobs` to `ready` on success; we only need to
// flip to `failed` here when the invocation itself never reached the
// builder (transport error, 5xx, misconfig). The outer try/catch is
// load-bearing — `invokeBuildArchive` throws when env vars are missing,
// and an uncaught `after()` exception would leave the row in `building`
// until the 20-minute stale sweep noticed.
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
