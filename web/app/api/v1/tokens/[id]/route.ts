import { requireAdmin } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { personalAccessTokens } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Token deletion is admin-only. Admins can revoke any user's PAT —
  // useful for off-boarding, compromised credentials, and pruning unused
  // tokens during an audit. The previous owner-scoped delete made
  // multi-user revocation impossible from the UI.
  const authResult = await requireAdmin();
  if (authResult instanceof Response) return authResult;

  const { id } = await params;

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    return apiError(400, VALIDATION_ERROR, "Invalid token ID");
  }

  const deleted = await db
    .delete(personalAccessTokens)
    .where(eq(personalAccessTokens.id, id))
    .returning({ id: personalAccessTokens.id });

  if (deleted.length === 0) {
    return apiError(404, NOT_FOUND, "Token not found");
  }

  return new Response(null, { status: 204 });
}
