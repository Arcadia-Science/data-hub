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
