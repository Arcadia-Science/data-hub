import { requireSession } from "@/lib/api/auth";
import { db } from "@/lib/db";
import { personalAccessTokens } from "@/lib/db/schema";
import { generateToken, getTokenPrefix, hashToken } from "@/lib/tokens";
import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function GET() {
  const authResult = await requireSession();
  if (!authResult) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tokens = await db
    .select({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
      token_prefix: personalAccessTokens.tokenPrefix,
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
  const authResult = await requireSession();
  if (!authResult) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { name?: string; expires_at?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) {
    return Response.json(
      { error: "name is required and must be at most 100 characters" },
      { status: 400 }
    );
  }

  let expiresAt: Date | null = null;
  if (body.expires_at) {
    expiresAt = new Date(body.expires_at);
    if (isNaN(expiresAt.getTime())) {
      return Response.json(
        { error: "expires_at must be a valid ISO 8601 date" },
        { status: 400 }
      );
    }
    if (expiresAt <= new Date()) {
      return Response.json(
        { error: "expires_at must be in the future" },
        { status: 400 }
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
      expiresAt,
    })
    .returning({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
      token_prefix: personalAccessTokens.tokenPrefix,
      expires_at: personalAccessTokens.expiresAt,
      created_at: personalAccessTokens.createdAt,
    });

  return Response.json({ ...inserted, token: plaintext }, { status: 201 });
}
