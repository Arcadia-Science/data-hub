import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createAuthClient } from "better-auth/client";
import {
  authBaseURL,
  authInstance,
  authIssuer,
  mcpResourceAudience,
} from "@/lib/auth";
import { authInfoFromPayload } from "@/lib/mcp/auth-helpers";

const resourceClient = createAuthClient({
  baseURL: authBaseURL,
  plugins: [oauthProviderResourceClient(authInstance)],
});

/**
 * `verifyToken` callback for mcp-handler's `withMcpAuth`.
 * Accepts JWT access tokens only (clients must request RFC 8707 `resource`
 * so the AS mints a JWT with `aud` = `mcpResourceAudience`). Personal access
 * tokens are not accepted: every MCP call acts as the signed-in person who
 * granted consent.
 */
export async function verifyMcpToken(
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> {
  if (!bearerToken) {
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
