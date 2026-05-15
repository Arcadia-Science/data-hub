import { apiError, FORBIDDEN, UNAUTHORIZED } from "@/lib/api/errors";
import { hasScope, type Scope } from "@/lib/api/scopes";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { personalAccessTokens } from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { after } from "next/server";

export type AuthResult = {
  userId: string;
  authMethod: "session" | "token";
  // Permission scopes carried by this request. Token-authenticated requests
  // carry the scopes column from `personal_access_tokens`. Session
  // (NextAuth) authentication is treated as fully privileged and always
  // returns `["*"]`, so `hasScope` is a no-op for browser sessions.
  scopes: string[];
};

/**
 * Validate a PAT from the Authorization header. Shared by both
 * `authenticateRequest` (session + token) and `authenticateWithToken`
 * (token-only) so the logic stays in one place.
 */
async function validatePat(
  authHeader: string | null
): Promise<AuthResult | null> {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const plaintext = authHeader.slice(7);
  // Reject tokens without our prefix early to avoid a needless DB lookup
  // when the bearer value is a JWT or other non-PAT credential.
  if (!plaintext.startsWith("dhub_")) {
    return null;
  }

  const hash = hashToken(plaintext);
  const [pat] = await db
    .select({
      id: personalAccessTokens.id,
      userId: personalAccessTokens.userId,
      expiresAt: personalAccessTokens.expiresAt,
      scopes: personalAccessTokens.scopes,
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

  // Defer the last-used timestamp update so it doesn't add latency to the
  // API response. next/server `after()` runs after the response is sent.
  after(async () => {
    await db
      .update(personalAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(personalAccessTokens.id, pat.id));
  });

  return { userId: pat.userId, authMethod: "token", scopes: pat.scopes };
}

/**
 * Resolve a v1 request to either a NextAuth session or a PAT. Sessions are
 * treated as fully privileged; PATs carry their stored `scopes` array.
 *
 * @internal — route handlers should call {@link authorize} instead, which
 * combines this with the per-route scope check. Exported only because
 * `authorize` lives in this same module and the test harness exercises
 * the surface through HTTP rather than direct calls.
 */
export async function authenticateRequest(
  request: NextRequest
): Promise<AuthResult | null> {
  const session = await auth();
  if (session?.user?.id) {
    return { userId: session.user.id, authMethod: "session", scopes: ["*"] };
  }

  return validatePat(request.headers.get("authorization"));
}

/**
 * Authenticate a request using only PAT (Personal Access Token) — skips the
 * NextAuth session check.  Use this for API surfaces (like MCP) where callers
 * will never have a browser session.
 */
export async function authenticateWithToken(
  request: Pick<Request, "headers">
): Promise<AuthResult | null> {
  return validatePat(request.headers.get("authorization"));
}

export async function requireSession(): Promise<AuthResult | null> {
  const session = await auth();
  if (session?.user?.id) {
    return { userId: session.user.id, authMethod: "session", scopes: ["*"] };
  }
  return null;
}

// Authenticates a v1 route request and checks for the given scope. Returns
// the resolved `AuthResult` on success, or a `Response` (401 if missing
// auth, 403 if the token lacks the scope) the handler should return. Not
// for session-only routes like `/api/v1/tokens` — those still use
// `requireSession()` directly.
export async function authorize(
  request: NextRequest,
  scope: Scope
): Promise<AuthResult | Response> {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }
  if (!hasScope(authResult, scope)) {
    return apiError(
      403,
      FORBIDDEN,
      `Token is missing required scope: ${scope}`
    );
  }
  return authResult;
}
