import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { personalAccessTokens } from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

type AuthResult = {
  userId: string;
  authMethod: "session" | "token";
};

export async function authenticateRequest(
  _request: NextRequest
): Promise<AuthResult | null> {
  const session = await auth();
  if (session?.user?.id) {
    return { userId: session.user.id, authMethod: "session" };
  }

  const authHeader = _request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const plaintext = authHeader.slice(7);
  if (!plaintext.startsWith("dhub_")) {
    return null;
  }

  const hash = hashToken(plaintext);
  const [pat] = await db
    .select({
      id: personalAccessTokens.id,
      userId: personalAccessTokens.userId,
      expiresAt: personalAccessTokens.expiresAt,
    })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.tokenHash, hash))
    .limit(1);

  if (!pat) {
    return null;
  }

  if (pat.expiresAt && pat.expiresAt < new Date()) {
    return null;
  }

  // Non-blocking last-used update (best-effort)
  db.update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalAccessTokens.id, pat.id))
    .then(
      () => {},
      () => {}
    );

  return { userId: pat.userId, authMethod: "token" };
}

export async function requireSession(): Promise<AuthResult | null> {
  const session = await auth();
  if (session?.user?.id) {
    return { userId: session.user.id, authMethod: "session" };
  }
  return null;
}
