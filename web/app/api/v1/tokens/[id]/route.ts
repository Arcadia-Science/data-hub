import { requireAdmin } from "@/lib/api/auth";
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
    return Response.json({ error: "Invalid token ID" }, { status: 400 });
  }

  const deleted = await db
    .delete(personalAccessTokens)
    .where(eq(personalAccessTokens.id, id))
    .returning({ id: personalAccessTokens.id });

  if (deleted.length === 0) {
    return Response.json({ error: "Token not found" }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
