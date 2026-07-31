import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

const ALLOWED_PATCH_FIELDS = new Set(["is_admin"]);

// Admin-only role toggle invoked by `/settings/members`. Only the
// `is_admin` boolean is mutable here; user identity fields (name, email,
// image) come from Google and are owned by the Better Auth adapter.
//
// Self-demotion is rejected to keep the "no admins left" failure mode out
// of the API. The members UI mirrors this by disabling the toggle on the
// current user's row, but the server-side check is what actually keeps
// the workspace from becoming admin-less.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const { userId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const unknownKeys = Object.keys(body).filter(
    (k) => !ALLOWED_PATCH_FIELDS.has(k)
  );
  if (unknownKeys.length > 0) {
    return apiError(400, VALIDATION_ERROR, "Unknown fields", {
      unknown_fields: unknownKeys,
      allowed_fields: [...ALLOWED_PATCH_FIELDS],
    });
  }

  if (!("is_admin" in body) || typeof body.is_admin !== "boolean") {
    return apiError(400, VALIDATION_ERROR, "is_admin must be a boolean");
  }

  const isAdmin = body.is_admin;

  // Self-demotion guard. Promotion-of-self is harmless (it's a no-op for
  // the caller, who is already admin) so we only reject the false case.
  if (authResult.userId === userId && isAdmin === false) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "Admins cannot demote themselves. Ask another admin to do it."
    );
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!existing) {
    return apiError(404, NOT_FOUND, `User '${userId}' not found`);
  }

  const [updated] = await db
    .update(users)
    .set({ isAdmin })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      is_admin: users.isAdmin,
    });

  return Response.json(updated);
}
