import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import { db } from "@/lib/db";
import { archiveJobs } from "@/lib/db/schema";
import { getPresignedDownloadUrl } from "@/lib/s3";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

// ---------------------------------------------------------------------------
// GET /api/v1/archive-jobs/:id
//
// Status polling for asynchronous archive builds. The UI calls this every
// few seconds while the Download dialog is open and follows `download_url`
// once `status === 'ready'`. The presigned URL is generated fresh on every
// poll so it never expires from under a slow user.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { id } = await params;
  if (!isValidUUID(id)) {
    return apiError(400, VALIDATION_ERROR, "Invalid job ID format");
  }

  const [job] = await db
    .select()
    .from(archiveJobs)
    .where(eq(archiveJobs.id, id))
    .limit(1);

  if (!job) {
    return apiError(404, NOT_FOUND, `Archive job '${id}' not found`);
  }

  let downloadUrl: string | null = null;
  if (job.status === "ready" && job.archiveBucket && job.archiveKey) {
    downloadUrl = await getPresignedDownloadUrl(
      job.archiveBucket,
      job.archiveKey
    );
  }

  return Response.json({
    id: job.id,
    instrument_run_id: job.instrumentRunId,
    fingerprint: job.fingerprint,
    status: job.status,
    archive_bucket: job.archiveBucket,
    archive_key: job.archiveKey,
    size_bytes: job.sizeBytes,
    error_message: job.errorMessage,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    download_url: downloadUrl,
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/archive-jobs/:id
//
// Lambda calls this when an async build finishes. The Lambda authenticates
// with the existing `DATA_HUB_API_KEY` PAT, which is already used for the
// reprocess and run-update flows, so we don't introduce a second secret.
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["ready", "failed"]);

type PatchBody = {
  status?: unknown;
  archive_bucket?: unknown;
  archive_key?: unknown;
  size_bytes?: unknown;
  error_message?: unknown;
};

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { id } = await params;
  if (!isValidUUID(id)) {
    return apiError(400, VALIDATION_ERROR, "Invalid job ID format");
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  if (
    typeof body.status !== "string" ||
    !["pending", "building", "ready", "failed"].includes(body.status)
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "status must be one of pending|building|ready|failed"
    );
  }

  const status = body.status as "pending" | "building" | "ready" | "failed";

  if (status === "ready") {
    if (
      typeof body.archive_bucket !== "string" ||
      typeof body.archive_key !== "string"
    ) {
      return apiError(
        400,
        VALIDATION_ERROR,
        "archive_bucket and archive_key are required when status is 'ready'"
      );
    }
  }

  const update: Partial<typeof archiveJobs.$inferInsert> = { status };
  if (typeof body.archive_bucket === "string") {
    update.archiveBucket = body.archive_bucket;
  }
  if (typeof body.archive_key === "string") {
    update.archiveKey = body.archive_key;
  }
  if (typeof body.size_bytes === "number") {
    update.sizeBytes = body.size_bytes;
  }
  if (typeof body.error_message === "string") {
    update.errorMessage = body.error_message;
  }
  if (TERMINAL_STATUSES.has(status)) {
    update.completedAt = new Date();
  }

  const [updated] = await db
    .update(archiveJobs)
    .set(update)
    .where(eq(archiveJobs.id, id))
    .returning();

  if (!updated) {
    return apiError(404, NOT_FOUND, `Archive job '${id}' not found`);
  }

  return Response.json({
    id: updated.id,
    status: updated.status,
    archive_bucket: updated.archiveBucket,
    archive_key: updated.archiveKey,
    size_bytes: updated.sizeBytes,
    error_message: updated.errorMessage,
    completed_at: updated.completedAt,
  });
}
