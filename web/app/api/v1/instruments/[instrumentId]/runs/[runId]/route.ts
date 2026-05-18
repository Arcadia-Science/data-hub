import { authorize } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import {
  lookupRunByNaturalKey,
  parseAcquiredAt,
} from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";
import { getPresignedDownloadUrl } from "@/lib/s3";
import { eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs/:runId
//
// Full run detail — files (with pre-signed download URLs) and run-level
// metadata.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:read");
  if (authResult instanceof Response) return authResult;

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  const fileRows = await db
    .select()
    .from(files)
    .where(eq(files.instrumentRunId, run.id))
    .orderBy(files.createdAt);

  // Generate short-lived pre-signed URLs only for files that have been
  // uploaded to S3 (s3Key is non-null). Detected/queued files get null.
  const filesWithUrls = await Promise.all(
    fileRows.map(async (f) => ({
      id: f.id,
      filename: f.filename,
      relative_path: f.relativePath,
      s3_key: f.s3Key,
      content_type: f.contentType,
      size_bytes: f.sizeBytes,
      category: f.category,
      status: f.status,
      metadata: f.metadata,
      error_message: f.errorMessage,
      detected_at: f.detectedAt,
      upload_requested_at: f.uploadRequestedAt,
      uploaded_at: f.uploadedAt,
      processed_at: f.processedAt,
      download_url:
        f.s3Bucket && f.s3Key
          ? await getPresignedDownloadUrl(f.s3Bucket, f.s3Key)
          : null,
      created_at: f.createdAt,
      file_created_at: f.fileCreatedAt,
    }))
  );

  return Response.json({
    id: run.id,
    instrument_id: run.instrumentId,
    instrument_display_name: run.instrumentDisplayName,
    run_id: run.runId,
    source: run.source,
    watcher_id: run.watcherId,
    created_at: run.createdAt,
    acquired_at: run.acquiredAt,
    updated_at: run.updatedAt,
    deleted_at: run.deletedAt,
    metadata: run.metadata,
    attributions: run.attributions,
    files: filesWithUrls,
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/instruments/:instrumentId/runs/:runId
//
// Supports two payload shapes:
//   - { metadata: {...} } — full replacement of run-level metadata
//   - { detected_files: [...] } — upsert new detected files (watcher path)
// Rejects updates to soft-deleted runs with 409.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:write");
  if (authResult instanceof Response) return authResult;

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  if (run.deletedAt) {
    return apiError(409, CONFLICT, "Cannot update a soft-deleted run");
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  // Metadata is a full replacement (not a deep merge). The Lambda writes the
  // complete metadata object after processing. Patch-by-key would require a
  // read-then-merge cycle that adds complexity with no benefit at current scale.
  if ("metadata" in body) {
    if (
      typeof body.metadata !== "object" ||
      body.metadata === null ||
      Array.isArray(body.metadata)
    ) {
      return apiError(400, VALIDATION_ERROR, "metadata must be a JSON object");
    }

    await db
      .update(instrumentRuns)
      .set({ metadata: body.metadata })
      .where(eq(instrumentRuns.id, run.id));
  }

  // Fold an incoming acquired_at into the row using LEAST so the run's
  // acquisition time can only ever move earlier (e.g. a later-stabilising
  // file with an older birthtime). Recomputed from detected_files when not
  // supplied explicitly — see parseAcquiredAt.
  //
  // Bind the ISO string + ::timestamptz cast: drizzle's sql tag has no
  // PgColumn context here to coerce a JS Date for the postgres-js driver,
  // which would otherwise throw ERR_INVALID_ARG_TYPE.
  const incomingAcquiredAt = parseAcquiredAt(body);
  if (incomingAcquiredAt) {
    const iso = incomingAcquiredAt.toISOString();
    await db
      .update(instrumentRuns)
      .set({
        acquiredAt: sql`least(coalesce(${instrumentRuns.acquiredAt}, ${iso}::timestamptz), ${iso}::timestamptz)`,
      })
      .where(eq(instrumentRuns.id, run.id));
  }

  // Handle detected_files upsert (watcher reporting new files for a run).
  const detectedFiles = Array.isArray(body.detected_files)
    ? body.detected_files
    : [];

  if (detectedFiles.length > 0) {
    const now = new Date();
    const fileValues = detectedFiles.map(
      (f: {
        relative_path: string;
        filename: string;
        size_bytes?: number;
        file_created_at?: string;
      }) => ({
        instrumentRunId: run.id,
        relativePath: f.relative_path,
        filename: f.filename,
        sizeBytes: f.size_bytes ?? null,
        status: "detected" as const,
        detectedAt: now,
        fileCreatedAt:
          typeof f.file_created_at === "string"
            ? new Date(f.file_created_at)
            : null,
      })
    );

    // Relies on the partial unique index (instrument_run_id, relative_path)
    // to skip files already reported for this run.
    await db.insert(files).values(fileValues).onConflictDoNothing();
  }

  // Re-fetch the updated run to return current state.
  const updated = await lookupRunByNaturalKey(instrumentId, runId);

  return Response.json({
    id: updated!.id,
    instrument_id: updated!.instrumentId,
    instrument_display_name: updated!.instrumentDisplayName,
    run_id: updated!.runId,
    source: updated!.source,
    watcher_id: updated!.watcherId,
    metadata: updated!.metadata,
    created_at: updated!.createdAt,
    acquired_at: updated!.acquiredAt,
    updated_at: updated!.updatedAt,
    deleted_at: updated!.deletedAt,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/instruments/:instrumentId/runs/:runId
//
// Soft-delete only — sets deleted_at. Does NOT cascade to files or remove
// S3 objects. Data Hub has no hard-delete path: a soft-deleted run remains
// fully restorable indefinitely via POST .../restore.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:write");
  if (authResult instanceof Response) return authResult;

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  if (run.deletedAt) {
    return apiError(409, CONFLICT, "Run is already deleted");
  }

  const now = new Date();
  await db
    .update(instrumentRuns)
    .set({ deletedAt: now })
    .where(eq(instrumentRuns.id, run.id));

  return Response.json({
    instrument_id: run.instrumentId,
    run_id: run.runId,
    deleted_at: now,
  });
}
