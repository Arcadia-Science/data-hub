import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { patchArchiveJobBody, readJsonBody } from "@/lib/api/openapi";
import { isValidUUID } from "@/lib/api/validators";
import { db } from "@/lib/db";
import { archiveJobs } from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/archive-jobs/:id
//
// Lambda callback used to flip an async build to its terminal state.
// Authenticates with the standard `Authorization: Bearer <PAT>` (or
// session) — same as every other API route. The Lambda calls this with
// its `DATA_HUB_API_KEY` PAT, the same credential it uses for every
// other Lambda → API call.
//
// Note: any authenticated caller can update an archive job (including
// writing arbitrary `archive_bucket`/`archive_key`). The UI does not
// trust this row's `status` for download readiness — it polls
// `/download-archive` which short-circuits on an S3 HEAD against the
// canonical archive key — so worst case a tampered row breaks its own
// download. We can tighten by validating `archive_bucket` /
// `archive_key` against the canonical shape if abuse becomes a real
// concern.
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["ready", "failed"]);

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "archive-jobs:write");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { id } = await params;
  if (!isValidUUID(id)) {
    return apiError(400, VALIDATION_ERROR, "Invalid job ID format");
  }

  const body = await readJsonBody(request, patchArchiveJobBody);
  if (body instanceof Response) {
    return body;
  }
  const status = body.status;

  if (status === "ready" && !(body.archive_bucket && body.archive_key)) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "archive_bucket and archive_key are required when status is 'ready'"
    );
  }

  const update: Partial<typeof archiveJobs.$inferInsert> = { status };
  if (body.archive_bucket !== undefined) {
    update.archiveBucket = body.archive_bucket;
  }
  if (body.archive_key !== undefined) {
    update.archiveKey = body.archive_key;
  }
  if (body.size_bytes !== undefined) {
    update.sizeBytes = body.size_bytes;
  }
  if (body.error_message !== undefined) {
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
