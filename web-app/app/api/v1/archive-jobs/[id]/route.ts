import {
  apiError,
  INTERNAL_ERROR,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import { db } from "@/lib/db";
import { archiveJobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

type RouteContext = {
  params: Promise<{ id: string }>;
};

// ---------------------------------------------------------------------------
// PATCH /api/v1/archive-jobs/:id
//
// Lambda-only callback. Authenticated with the shared `LAMBDA_INVOKE_TOKEN`
// the same way the Function URL itself is authenticated — *not* with a
// user PAT. This is deliberate: the PATCH lets the caller mark a build as
// ready with arbitrary `archive_bucket` / `archive_key`, so allowing
// regular session/token auth would let any signed-in user redirect another
// user's download or DoS in-flight builds. By gating on a server-only
// secret, the only writer is the Lambda execution.
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["ready", "failed"]);

type PatchBody = {
  status?: unknown;
  archive_bucket?: unknown;
  archive_key?: unknown;
  size_bytes?: unknown;
  error_message?: unknown;
};

// Constant-time bearer-token check against `LAMBDA_INVOKE_TOKEN`. Returns
// a Response on failure so callers can `return` it directly. Using the
// same secret already shared with the Lambda Function URL keeps the
// number of distinct shared secrets the operator has to manage at one.
function authenticateLambdaCallback(request: NextRequest): Response | null {
  const expected = process.env.LAMBDA_INVOKE_TOKEN;
  if (!expected) {
    return apiError(
      503,
      INTERNAL_ERROR,
      "LAMBDA_INVOKE_TOKEN is not configured; cannot accept archive-job callbacks"
    );
  }

  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }
  const presented = header.slice("Bearer ".length);

  // Length check first so timingSafeEqual doesn't throw on mismatched
  // byte lengths. The length itself isn't secret.
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }
  return null;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const authError = authenticateLambdaCallback(request);
  if (authError) return authError;

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
