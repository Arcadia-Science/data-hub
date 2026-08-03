import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { apiError, FORBIDDEN, UNAUTHORIZED } from "@/lib/api/errors";
import { hasScope, type Scope } from "@/lib/api/scopes";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { personalAccessTokens, users } from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens";

export interface AuthResult {
  authMethod: "session" | "token";
  // Permission scopes carried by this request. Token-authenticated requests
  // carry the scopes column from `personal_access_tokens`. Session
  // (Better Auth session) authentication is treated as fully privileged and
  // always returns `["*"]`, so `hasScope` is a no-op for browser sessions.
  scopes: string[];
  // PAT row id for token auth; null for sessions. Used to bind watchers to
  // the credential that registered them (see `enforceWatcherBinding`).
  tokenId: string | null;
  userId: string;
}

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

  return {
    userId: pat.userId,
    authMethod: "token",
    scopes: pat.scopes,
    tokenId: pat.id,
  };
}

/**
 * Resolve a v1 request to either a Better Auth session or a PAT. Sessions
 * are treated as fully privileged; PATs carry their stored `scopes` array.
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
    return {
      userId: session.user.id,
      authMethod: "session",
      scopes: ["*"],
      tokenId: null,
    };
  }

  // Await explicitly. Returning the Promise directly was enough for the
  // runtime, but Next 16.3's minifier then dropped the null check in
  // `authorize` and called `hasScope(null, …)` → 500 instead of 401.
  return await validatePat(request.headers.get("authorization"));
}

/**
 * Authenticate a request using only PAT (Personal Access Token) — skips the
 * session check. Use this for API surfaces (like MCP) where callers will
 * never have a browser session.
 */
export async function authenticateWithToken(
  request: Pick<Request, "headers">
): Promise<AuthResult | null> {
  return await validatePat(request.headers.get("authorization"));
}

export async function requireSession(): Promise<AuthResult | null> {
  const session = await auth();
  if (session?.user?.id) {
    return {
      userId: session.user.id,
      authMethod: "session",
      scopes: ["*"],
      tokenId: null,
    };
  }
  return null;
}

/**
 * Session-only admin gate. Use for routes that have no PAT analogue
 * (PAT create/delete, member toggle). Returns the authenticated user's id
 * on success, or a `Response` (401 if not signed in, 403 if signed in but
 * not admin) that the handler should return.
 *
 * The admin check always reads `users.is_admin` directly so a demotion via
 * `/settings/members` takes effect on the next request — the session's
 * cached `session.user.isAdmin` is used only for cheap UI affordance gating.
 */
export async function requireAdmin(): Promise<{ userId: string } | Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const [row] = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  if (!row?.isAdmin) {
    return apiError(403, FORBIDDEN, "Admin role required");
  }

  return { userId: session.user.id };
}

/**
 * Layered admin gate for routes that accept either a session or a PAT.
 * Given an already-resolved `AuthResult` from {@link authorize}, enforce
 * the admin role on session-authenticated callers but leave PAT callers
 * alone — the watcher and Lambda PATs continue to authenticate purely via
 * their stored `scopes` array. Returns `null` to indicate "all good", or a
 * 403 `Response` the caller should return immediately.
 *
 * Splitting this from {@link requireAdmin} keeps the admin DB lookup off
 * the hot PAT path (every watcher heartbeat / Lambda callback) — only
 * session-authenticated mutations pay for it.
 */
export async function requireAdminForSession(
  authResult: AuthResult
): Promise<Response | null> {
  if (authResult.authMethod !== "session") {
    return null;
  }

  const [row] = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, authResult.userId))
    .limit(1);

  if (!row?.isAdmin) {
    return apiError(403, FORBIDDEN, "Admin role required");
  }

  return null;
}

// Shared 401/403 gate so both authorize helpers keep an identical, hard-to-
// minify-away null check (see `authenticateRequest` await note above).
function enforceScope(
  authResult: AuthResult | null,
  scope: Scope
): AuthResult | Response {
  if (authResult === null) {
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

// Authenticates a v1 route request and checks for the given scope. Returns
// the resolved `AuthResult` on success, or a `Response` (401 if missing
// auth, 403 if the token lacks the scope) the handler should return. Not
// for session-only routes like `/api/v1/tokens` — those still use
// `requireSession()` directly.
export async function authorize(
  request: NextRequest,
  scope: Scope
): Promise<AuthResult | Response> {
  return enforceScope(await authenticateRequest(request), scope);
}

// Same contract as {@link authorize}, but PAT-only — sessions are never
// consulted. Use for machine-to-machine routes (e.g. Lambda file create)
// where accepting a browser session would grant `*` scope and open an
// attack surface that PATs with least-privilege scopes avoid.
export async function authorizeToken(
  request: NextRequest,
  scope: Scope
): Promise<AuthResult | Response> {
  return enforceScope(await authenticateWithToken(request), scope);
}
