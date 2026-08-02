import { createHash } from "node:crypto";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createAuthClient } from "better-auth/client";
import { eq } from "drizzle-orm";
import type { JWTPayload } from "jose";
import { authenticateWithToken } from "@/lib/api/auth";
import {
  authBaseURL,
  authInstance,
  authIssuer,
  mcpResourceAudience,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { oauthAccessTokens, sessions } from "@/lib/db/schema";
import { flattenPatScopes } from "@/lib/mcp/pat-scopes";

const resourceClient = createAuthClient({
  baseURL: authBaseURL,
  plugins: [oauthProviderResourceClient(authInstance)],
});

function hashOpaqueAccessToken(token: string): string {
  // Matches Better Auth oauth-provider defaultHasher (SHA-256, base64url, no pad).
  return createHash("sha256").update(token).digest("base64url");
}

function authInfoFromPayload(
  payload: JWTPayload,
  bearerToken: string
): AuthInfo | undefined {
  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!sub) {
    return;
  }

  const scopeClaim = payload.scope ?? payload.scp;
  const scopes = Array.isArray(scopeClaim)
    ? scopeClaim.map(String)
    : typeof scopeClaim === "string"
      ? scopeClaim.split(/\s+/).filter(Boolean)
      : [];

  const clientId =
    (typeof payload.client_id === "string" && payload.client_id) ||
    (typeof payload.azp === "string" && payload.azp) ||
    "unknown";

  return {
    token: bearerToken,
    clientId,
    scopes,
    extra: { userId: sub },
  };
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function isPatFallbackEnabled(): boolean {
  // Hard-off in Vercel production deployments even if the flag is set.
  return (
    process.env.MCP_ALLOW_PAT_AUTH === "true" &&
    process.env.VERCEL_ENV !== "production"
  );
}

/**
 * Opaque access tokens are issued when the client omits RFC 8707 `resource`
 * (better-auth 1.6). Look them up in the AS database and require a live
 * session when one is bound.
 *
 * 1.6's `oauth_access_token` table has no `revoked` / `resources` /
 * `confirmation` columns (those land in 1.7). Opaque rows are destroyed on
 * revoke, minted only without an audience, and never DPoP-bound.
 */
async function verifyOpaqueAccessToken(
  bearerToken: string
): Promise<AuthInfo | undefined> {
  const hashed = hashOpaqueAccessToken(bearerToken);
  const [accessToken] = await db
    .select()
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.token, hashed))
    .limit(1);

  if (!accessToken) {
    console.error("[mcp] opaque token not found");
    return;
  }

  if (!accessToken.expiresAt || accessToken.expiresAt < new Date()) {
    console.error("[mcp] opaque token expired");
    return;
  }

  if (accessToken.sessionId) {
    const [session] = await db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, accessToken.sessionId))
      .limit(1);
    if (!session || session.expiresAt < new Date()) {
      console.error("[mcp] opaque token session inactive");
      return;
    }
  }

  if (!accessToken.userId) {
    console.error("[mcp] opaque token missing user");
    return;
  }

  return {
    token: bearerToken,
    clientId: accessToken.clientId,
    scopes: accessToken.scopes ?? [],
    extra: { userId: accessToken.userId },
  };
}

async function verifyPatFallback(
  req: Request,
  bearerToken: string
): Promise<AuthInfo | undefined> {
  const result = await authenticateWithToken(req);
  if (!result) {
    return;
  }

  return {
    token: bearerToken,
    clientId: result.userId,
    scopes: flattenPatScopes(result.scopes),
    extra: { userId: result.userId },
  };
}

/**
 * `verifyToken` callback for mcp-handler's `withMcpAuth`.
 * Validates a Bearer access token against Better Auth JWKS (JWT) or the
 * local opaque-token store when the client omitted `resource`. Optionally
 * falls back to PATs outside production when `MCP_ALLOW_PAT_AUTH=true`.
 */
export async function verifyMcpToken(
  req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> {
  if (!bearerToken) {
    return;
  }

  try {
    // better-auth 1.6 exposes `verifyAccessToken(token)`; 1.7's
    // `verifyAccessTokenRequest(req)` (DPoP-aware) is not available yet.
    const payload = await resourceClient.verifyAccessToken(bearerToken, {
      verifyOptions: {
        audience: mcpResourceAudience,
        // Must match JWT `iss` / AS metadata issuer (`{origin}/api/auth`).
        issuer: authIssuer,
      },
      jwksUrl: `${authIssuer}/jwks`,
    });
    return authInfoFromPayload(payload, bearerToken);
  } catch (error) {
    if (looksLikeJwt(bearerToken)) {
      console.error("[mcp] token verification failed", error);
    } else {
      try {
        const opaque = await verifyOpaqueAccessToken(bearerToken);
        if (opaque) {
          return opaque;
        }
        console.error(
          "[mcp] opaque token verification failed after JWT path miss",
          error
        );
      } catch (opaqueError) {
        console.error("[mcp] opaque token verification error", opaqueError);
      }
    }
  }

  if (isPatFallbackEnabled()) {
    try {
      const pat = await verifyPatFallback(req, bearerToken);
      if (pat) {
        return pat;
      }
    } catch (patError) {
      console.error("[mcp] PAT fallback verification error", patError);
    }
  }

  return;
}
