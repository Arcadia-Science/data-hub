import { requireSession } from "@/lib/api/auth";
import { db } from "@/lib/db";
import { personalAccessTokens } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireSession();
  if (!authResult) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    return Response.json({ error: "Invalid token ID" }, { status: 400 });
  }

  // Scope the delete to the authenticated user so one user can never
  // delete another user's token — a non-match returns 0 rows → 404.
  const deleted = await db
    .delete(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.id, id),
        eq(personalAccessTokens.userId, authResult.userId)
      )
    )
    .returning({ id: personalAccessTokens.id });

  if (deleted.length === 0) {
    return Response.json({ error: "Token not found" }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
