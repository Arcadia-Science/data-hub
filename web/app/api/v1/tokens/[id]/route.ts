import { and, eq, isNull } from "drizzle-orm";
import { trackEvent } from "@/lib/analytics/track";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { personalAccessTokens, watchers } from "@/lib/db/schema";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Token revocation is admin-only. Admins can revoke any user's PAT —
  // useful for off-boarding, compromised credentials, and pruning unused
  // tokens during an audit. The row is kept (with `revoked_at` set) so audit
  // columns that reference the token can still show its name.
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const { id } = await params;

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    return apiError(400, VALIDATION_ERROR, "Invalid token ID");
  }

  const revoked = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(personalAccessTokens.id, id),
          isNull(personalAccessTokens.revokedAt)
        )
      )
      .returning({ id: personalAccessTokens.id });
    if (!row) {
      return false;
    }
    // Watchers bound to this token become claimable again, so a replacement
    // token can take over the instrument (trust on first use).
    await tx
      .update(watchers)
      .set({ registeredByToken: null })
      .where(eq(watchers.registeredByToken, id));
    return true;
  });

  if (!revoked) {
    return apiError(404, NOT_FOUND, "Token not found");
  }

  trackEvent("token_revoked", { user_id: authResult.userId });

  return new Response(null, { status: 204 });
}
