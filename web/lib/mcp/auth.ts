import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createAuthClient } from "better-auth/client";
import { authenticateWithToken } from "@/lib/api/auth";
import {
  authBaseURL,
  authInstance,
  authIssuer,
  mcpResourceAudience,
} from "@/lib/auth";
import {
  authInfoFromPayload,
  isPatFallbackEnabled,
} from "@/lib/mcp/auth-helpers";
import { flattenPatScopes } from "@/lib/mcp/pat-scopes";

const resourceClient = createAuthClient({
  baseURL: authBaseURL,
  plugins: [oauthProviderResourceClient(authInstance)],
});

function isPatBearer(token: string): boolean {
  return token.startsWith("dhub_");
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
 * Accepts JWT access tokens only (clients must request RFC 8707 `resource`
 * so the AS mints a JWT with `aud` = `mcpResourceAudience`). Optionally
 * falls back to PATs outside production when `MCP_ALLOW_PAT_AUTH=true`.
 */
export async function verifyMcpToken(
  req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> {
  if (!bearerToken) {
    return;
  }

  // PATs are never JWTs — try the fallback first so we don't burn a JWKS
  // round-trip (and log a verification miss) on every flagged PAT request.
  if (isPatFallbackEnabled() && isPatBearer(bearerToken)) {
    try {
      const pat = await verifyPatFallback(req, bearerToken);
      if (pat) {
        return pat;
      }
    } catch (patError) {
      console.error("[mcp] PAT fallback verification error", patError);
    }
    return;
  }

  try {
    // better-auth 1.6 exposes `verifyAccessToken(token)`; 1.7's
    // `verifyAccessTokenRequest(req)` (DPoP-aware) is not available yet.
    // Opaque tokens (no `resource` at token exchange) are rejected — JWKS
    // verification requires a JWT, and we intentionally do not hand-roll
    // DB lookups that skip audience checks.
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
    // Expected for missing/invalid Bearer tokens.
    if (process.env.NODE_ENV !== "production") {
      console.debug("[mcp] JWT verification failed", error);
    }
  }

  return;
}
