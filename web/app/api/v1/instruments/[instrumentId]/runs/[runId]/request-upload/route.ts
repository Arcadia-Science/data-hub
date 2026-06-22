import { eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  NOT_FOUND,
  VALIDATION_ERROR,
  WATCHER_OFFLINE,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { instrumentHasOnlineWatcher } from "@/lib/api/instruments";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload
//
// Transitions detected files to upload_requested status. Called by the web UI
// when a user selects files (or an entire run) to upload. Files already in
// upload_requested status are silently skipped (idempotent). Files that have
// progressed past upload_requested, are soft-deleted, or belong to a different
// run are rejected.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:write");
  if (authResult instanceof Response) {
    return authResult;
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

  if (run.deletedAt) {
    return apiError(
      409,
      CONFLICT,
      "Cannot request uploads for a soft-deleted run"
    );
  }

  // Uploads are performed by the watcher agent (it polls this queue and pushes
  // bytes to S3). With no online watcher the files would be marked
  // `upload_requested` and never progress, leaving the UI stuck on
  // "Uploading". Reject up front so the caller gets a clear, actionable error.
  if (!(await instrumentHasOnlineWatcher(run.instrumentId))) {
    return apiError(
      409,
      WATCHER_OFFLINE,
      "No online watcher for this instrument. Bring the watcher online before requesting uploads — otherwise nothing will transfer to S3."
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const MAX_FILE_IDS = 100;
  const rawFileIds = Array.isArray(body.file_ids) ? body.file_ids : [];
  if (rawFileIds.length === 0) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "file_ids must be a non-empty array"
    );
  }
  if (rawFileIds.length > MAX_FILE_IDS) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `file_ids cannot exceed ${MAX_FILE_IDS} entries`
    );
  }
  if (
    !rawFileIds.every(
      (id: unknown) => typeof id === "number" && Number.isInteger(id)
    )
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "file_ids must contain only integer values"
    );
  }
  const fileIds: number[] = rawFileIds;

  // Fetch all specified files in a single query to validate ownership,
  // status, and soft-delete state in bulk.
  const requestedFiles = await db
    .select()
    .from(files)
    .where(inArray(files.id, fileIds));

  const requestedById = new Map(requestedFiles.map((f) => [f.id, f]));

  // Validate every requested file before making any mutations. This ensures
  // atomicity: either all files pass validation and get queued, or none do.
  // Without this pre-check, a partial failure could leave the batch in an
  // inconsistent state that's confusing for the UI.
  for (const fid of fileIds) {
    const f = requestedById.get(fid);
    if (!f) {
      return apiError(400, VALIDATION_ERROR, `File ${fid} not found`);
    }
    if (f.instrumentRunId !== run.id) {
      return apiError(
        400,
        VALIDATION_ERROR,
        `File ${fid} does not belong to this run`
      );
    }
    if (f.deletedAt) {
      return apiError(400, VALIDATION_ERROR, `File ${fid} has been deleted`);
    }
    // Allow detected → upload_requested; skip files already in
    // upload_requested (idempotent). Reject any other status.
    if (f.status !== "detected" && f.status !== "upload_requested") {
      return apiError(
        400,
        VALIDATION_ERROR,
        `File ${fid} is in '${f.status}' status and cannot be queued for upload`
      );
    }
  }

  const now = new Date();

  // Only transition files that are still in "detected" — skip those already
  // in "upload_requested" to make the endpoint idempotent.
  const toTransition = fileIds.filter(
    (fid: number) => requestedById.get(fid)!.status === "detected"
  );

  if (toTransition.length > 0) {
    await db
      .update(files)
      .set({ status: "upload_requested", uploadRequestedAt: now })
      .where(inArray(files.id, toTransition));
  }

  // Touch the parent run so watchers can detect changes via updated_at.
  await db
    .update(instrumentRuns)
    .set({ updatedAt: now })
    .where(eq(instrumentRuns.id, run.id));

  // Build the response with the upload_requested_at for all files (both
  // newly transitioned and already-queued).
  const responseFiles = fileIds.map((fid: number) => {
    const f = requestedById.get(fid)!;
    return {
      id: f.id,
      filename: f.filename,
      upload_requested_at:
        f.status === "upload_requested" ? f.uploadRequestedAt : now,
    };
  });

  return Response.json({
    instrument_id: run.instrumentId,
    run_id: run.runId,
    files_queued: fileIds.length,
    files: responseFiles,
  });
}
