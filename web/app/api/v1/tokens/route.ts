import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { requireAdmin, requireSession } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED, VALIDATION_ERROR } from "@/lib/api/errors";
import { validateRequestedScopes } from "@/lib/api/scopes";
import { db } from "@/lib/db";
import { personalAccessTokens } from "@/lib/db/schema";
import { generateToken, getTokenPrefix, hashToken } from "@/lib/tokens";

export async function GET() {
  // Listing is open to any signed-in user — regular members see their own
  // tokens here. The workspace-wide audit list shown on `/settings/tokens`
  // bypasses this endpoint entirely (it queries the DB directly in the
  // server component), so this remains a per-user view consistent with
  // typical PAT-management UIs.
  const authResult = await requireSession();
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const tokens = await db
    .select({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
      token_prefix: personalAccessTokens.tokenPrefix,
      scopes: personalAccessTokens.scopes,
      last_used_at: personalAccessTokens.lastUsedAt,
      expires_at: personalAccessTokens.expiresAt,
      created_at: personalAccessTokens.createdAt,
    })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, authResult.userId))
    .orderBy(desc(personalAccessTokens.createdAt));

  return Response.json(tokens);
}

export async function POST(request: NextRequest) {
  // Token creation is admin-only. Non-admins can still view the workspace
  // PAT list on `/settings/tokens` and call `GET` above, but only admins
  // can mint new credentials.
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  let body: { name?: string; expires_at?: string; scopes?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "name is required and must be at most 100 characters"
    );
  }

  const validation = validateRequestedScopes(body.scopes);
  if (!validation.ok) {
    return apiError(400, VALIDATION_ERROR, validation.error);
  }
  const scopes = validation.scopes;

  let expiresAt: Date | null = null;
  if (body.expires_at) {
    expiresAt = new Date(body.expires_at);
    if (isNaN(expiresAt.getTime())) {
      return apiError(
        400,
        VALIDATION_ERROR,
        "expires_at must be a valid ISO 8601 date"
      );
    }
    if (expiresAt <= new Date()) {
      return apiError(
        400,
        VALIDATION_ERROR,
        "expires_at must be in the future"
      );
    }
  }

  // Only the hash is persisted — the plaintext is returned in this response
  // and can never be retrieved again.
  const plaintext = generateToken();
  const tokenHash = hashToken(plaintext);
  const tokenPrefix = getTokenPrefix(plaintext);

  const [inserted] = await db
    .insert(personalAccessTokens)
    .values({
      userId: authResult.userId,
      name,
      tokenHash,
      tokenPrefix,
      scopes,
      expiresAt,
    })
    .returning({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
      token_prefix: personalAccessTokens.tokenPrefix,
      scopes: personalAccessTokens.scopes,
      expires_at: personalAccessTokens.expiresAt,
      created_at: personalAccessTokens.createdAt,
    });

  return Response.json({ ...inserted, token: plaintext }, { status: 201 });
}
