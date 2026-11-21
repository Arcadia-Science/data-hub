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
import {
  adoptPreUploadFile,
  fillMissingSource,
  lockSourceDeletion,
  reviveProcessedFile,
} from "@/lib/api/files";
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
//
// A processor writes its output to S3 before it registers it, so a regenerated
// output has already replaced the old object when it gets here. If the row that
// holds the key was deleted, a processed one becomes the new output (see
// `reviveProcessedFile`), so a reprocess doesn't leave its output hidden. A
// deleted raw row is never revived, only returned.
//
// `source_file_id` names the raw file of this run that a processed file was
// made from. A processed file made from a deleted raw file is saved deleted,
// the way the raw file was, because that file was deleted while it processed.
// The insert and the revive read the source with a lock in their own
// transaction (`lockSourceDeletion`), so a delete of the source that runs at
// the same time can't leave the output active. An existing active processed
// file that has no source yet is linked to it.
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

  // The raw file a processed file was made from. It may be deleted.
  const sourceFileId = body.source_file_id ?? null;
  if (sourceFileId !== null) {
    if (category !== "processed") {
      return apiError(
        400,
        VALIDATION_ERROR,
        "source_file_id is only for processed files"
      );
    }
    if (!(await isRawFileOfRun(run.id, sourceFileId))) {
      return apiError(
        400,
        VALIDATION_ERROR,
        "source_file_id must be a raw file of this run"
      );
    }
  }

  const now = new Date();

  // Answers for a row that already holds this S3 key: an active one is
  // returned as it is, linked to its source if it had none. A deleted processed
  // one in the same bucket becomes the new output. Any other deleted row, a raw
  // file above all, is returned as it is, still deleted.
  const respondForKeyHolder = async (
    holder: typeof files.$inferSelect
  ): Promise<Response> => {
    if (!holder.deletedAt) {
      const linked = await fillMissingSource(holder, sourceFileId);
      return Response.json(formatFileResponse(linked), { status: 200 });
    }
    if (
      holder.category !== "processed" ||
      category !== "processed" ||
      holder.s3Bucket !== s3Bucket
    ) {
      return Response.json(formatFileResponse(holder), { status: 200 });
    }
    const revived = await reviveProcessedFile(holder.id, {
      contentType: contentType ?? holder.contentType,
      sizeBytes: sizeBytes ?? holder.sizeBytes,
      sourceFileId: sourceFileId ?? holder.sourceFileId,
    });
    if (revived.kind === "conflict") {
      return apiError(
        409,
        CONFLICT,
        "Another file already uses this S3 key or path"
      );
    }
    if (revived.kind === "unchanged") {
      return revived.row
        ? Response.json(formatFileResponse(revived.row), { status: 200 })
        : apiError(
            409,
            CONFLICT,
            "Another file already uses this S3 key or path"
          );
    }
    await touchRuns([run.id]);
    return Response.json(formatFileResponse(revived.row), { status: 200 });
  };

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
    // again (likely a retry after a warm-container timeout, or a reprocess).
    // Don't regress status — return the existing record, only linked to its
    // source if it had none.
    const linked = await fillMissingSource(existing, sourceFileId);
    return Response.json(formatFileResponse(linked), { status: 200 });
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

  // A deleted row can hold the key. `uq_files_s3_key` covers deleted rows, so
  // the insert below can't add a second one.
  const [keyHolder] = await db
    .select()
    .from(files)
    .where(and(eq(files.instrumentRunId, run.id), eq(files.s3Key, s3Key)))
    .limit(1);
  if (keyHolder) {
    return await respondForKeyHolder(keyHolder);
  }

  // No row to adopt or revive — insert one. Set relativePath = filename so that
  // future watcher reports also dedup against this row via the existing
  // (instrument_run_id, relative_path) partial unique index, which covers
  // active rows only, so a dismissed row at that path doesn't block this
  // insert. The onConflictDoNothing() guards against concurrent retries that
  // race past the lookup above.
  const inserted = await db.transaction(async (tx) => {
    const deletion = await lockSourceDeletion(tx, sourceFileId);
    const [row] = await tx
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
        sourceFileId,
        ...deletion,
        status: "uploaded",
        uploadedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    return row;
  });

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
      return await respondForKeyHolder(raced);
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

// Whether `sourceFileId` is a raw file of this run, deleted or not.
async function isRawFileOfRun(
  runId: string,
  sourceFileId: number
): Promise<boolean> {
  const [row] = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.id, sourceFileId),
        eq(files.instrumentRunId, runId),
        eq(files.category, "raw")
      )
    )
    .limit(1);
  return row !== undefined;
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
    deleted_at: f.deletedAt,
  };
}
