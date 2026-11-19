import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  INTERNAL_ERROR,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { adoptPreUploadFile } from "@/lib/api/files";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { createFileBody, readJsonBody } from "@/lib/api/openapi";
import {
  bucketForCategory,
  runFileLocationError,
} from "@/lib/api/run-file-location";
import { readRunIdParam } from "@/lib/api/run-id-param";
import { touchRuns } from "@/lib/api/touch-runs";
import { enforceWatcherTokenInstrument } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { PRE_UPLOAD_FILE_STATUSES } from "@/lib/runs/file-buckets";

// Statuses where a row is "pre-S3": it has no location yet, so the Lambda
// path may adopt a watcher-created row and set one. Anything beyond uploaded
// is left untouched so Lambda retries don't regress in-progress / completed
// work.
const PRE_UPLOAD_STATUSES = new Set<string>(PRE_UPLOAD_FILE_STATUSES);

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/files
//
// Creates a file record with S3 info — this is the Lambda path. The file
// starts in "uploaded" status because the Lambda already has the file in S3
// by the time it calls this endpoint.
//
// The location must be the file's own: `<instrument>/<run>/<filename>` in the
// bucket for its category (`runFileLocationError`). Download links are signed
// for whatever a row stores, so accepting any location let a token register a
// file on its own run that pointed at another instrument's object (ENG-2275).
// A row's location is set once, when it moves from pre-upload to uploaded,
// and never rewritten.
//
// PAT-only (no browser sessions): session auth carries `*` scope, and
// accepting it let any signed-in user overwrite a pre-upload file's
// s3_bucket/s3_key via the adoption branch below (ENG-1455).
//
// Idempotent on s3_key: if a file of this run already has the key (partial
// unique index), returns the existing record with 200 instead of 201. A file
// of another run holding the key, or another file of this run holding the
// path, gets 409.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorizeToken(request, "files:create");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId: runIdParam } = await params;
  const denied = await enforceWatcherTokenInstrument(authResult, instrumentId);
  if (denied) {
    return denied;
  }
  const runId = readRunIdParam(request.headers, runIdParam);
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  if (run.deletedAt) {
    return apiError(409, CONFLICT, "Cannot add files to a soft-deleted run");
  }

  const body = await readJsonBody(request, createFileBody);
  if (body instanceof Response) {
    return body;
  }

  const s3Bucket = body.s3_bucket;
  const s3Key = body.s3_key;
  const filename = body.filename;
  const contentType = body.content_type ?? null;
  const sizeBytes = body.size_bytes ?? null;
  const category = body.category ?? "raw";

  let expectedBucket: string;
  try {
    expectedBucket = bucketForCategory(category);
  } catch {
    return apiError(500, INTERNAL_ERROR, "S3 bucket configuration is missing");
  }
  // Checked before any lookup, so a bad location never reaches the adopt,
  // retry or insert branches below.
  const locationError = runFileLocationError({
    instrumentId: run.instrumentId,
    runId: run.runId,
    filename,
    category,
    expectedBucket,
    s3Bucket,
    s3Key,
  });
  if (locationError) {
    return apiError(400, VALIDATION_ERROR, locationError);
  }

  const now = new Date();

  // Reconcile against any active row the watcher may have already created
  // for this file. Both writers now share the partial unique index on
  // (instrument_run_id, filename) WHERE deleted_at IS NULL, so we look up
  // by that key and adopt the existing row in place rather than inserting
  // a parallel one. Without this, a watcher-reported "detected" row would
  // be left orphaned forever after the Lambda fired.
  const [existing] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, run.id),
        eq(files.filename, filename),
        isNull(files.deletedAt)
      )
    )
    .limit(1);

  if (existing && !PRE_UPLOAD_STATUSES.has(existing.status)) {
    // Already uploaded / processing / completed / failed: Lambda is calling
    // again (likely a retry after a warm-container timeout). Don't regress
    // status — return the existing record as-is.
    return Response.json(formatFileResponse(existing), { status: 200 });
  }

  if (existing) {
    const adopt = await adoptPreUploadFile(existing.id, {
      s3Bucket,
      s3Key,
      // The Lambda omits content_type/size_bytes for raw uploads; keep
      // what the watcher's detected_files report recorded rather than
      // wiping the columns to null.
      contentType: contentType ?? existing.contentType,
      sizeBytes: sizeBytes ?? existing.sizeBytes,
      // Honour the Lambda-supplied category when adopting a row. The
      // watcher always inserts with the default ("raw"), so without
      // this the insert vs. reconcile branches would diverge for
      // Lambda-classified processed files.
      category,
      uploadedAt: now,
    });

    if (adopt.kind === "adopted") {
      await touchRuns([run.id]);
      return Response.json(formatFileResponse(adopt.row), { status: 200 });
    }
    if (adopt.kind === "moved_on") {
      // The row left pre-upload after the read above. Return it as it is
      // now, like a retry on an uploaded row.
      return Response.json(formatFileResponse(adopt.row), { status: 200 });
    }
    // Dismissed after the read above: it no longer blocks a new row, so
    // insert one below.
  }

  // No active row to adopt — insert one. Set relativePath = filename so that
  // future watcher reports also dedup against this row via the existing
  // (instrument_run_id, relative_path) partial unique index, which covers
  // active rows only, so a dismissed row at that path doesn't block this
  // insert. The onConflictDoNothing() guards against concurrent retries that
  // race past the lookup above.
  const [inserted] = await db
    .insert(files)
    .values({
      instrumentRunId: run.id,
      relativePath: filename,
      s3Bucket,
      s3Key,
      filename,
      contentType,
      sizeBytes,
      category,
      status: "uploaded",
      uploadedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    // Another concurrent insert won — fetch and return that row. Look up
    // by s3_key first (the most specific dedup key here) and fall back to
    // the (run, filename) key. Both stay inside this run: `uq_files_s3_key`
    // spans every run, so a conflict on it can come from another run's row,
    // which this route must not hand back.
    const [raced] = await db
      .select()
      .from(files)
      .where(and(eq(files.instrumentRunId, run.id), eq(files.s3Key, s3Key)))
      .limit(1);

    if (raced) {
      return Response.json(formatFileResponse(raced), { status: 200 });
    }

    const [racedByName] = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.instrumentRunId, run.id),
          eq(files.filename, filename),
          isNull(files.deletedAt)
        )
      )
      .limit(1);

    if (!racedByName) {
      return apiError(
        409,
        CONFLICT,
        "Another file already uses this S3 key or path"
      );
    }
    return Response.json(formatFileResponse(racedByName), { status: 200 });
  }

  await touchRuns([run.id]);
  return Response.json(formatFileResponse(inserted), { status: 201 });
}

function formatFileResponse(f: typeof files.$inferSelect) {
  return {
    id: f.id,
    instrument_run_id: f.instrumentRunId,
    relative_path: f.relativePath,
    s3_bucket: f.s3Bucket,
    s3_key: f.s3Key,
    filename: f.filename,
    content_type: f.contentType,
    size_bytes: f.sizeBytes,
    category: f.category,
    status: f.status,
    metadata: f.metadata,
    error_message: f.errorMessage,
    uploaded_at: f.uploadedAt,
    processed_at: f.processedAt,
    processing_started_at: f.processingStartedAt,
    created_at: f.createdAt,
    file_created_at: f.fileCreatedAt,
  };
}
