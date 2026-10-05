import type { AuthInfo } from "@modelcontextprotocol/server";
import type { JWTPayload } from "jose";

/**
 * Map a verified JWT access-token payload onto MCP `AuthInfo`.
 * Rejects machine tokens (`client_credentials`) where `sub` is the client
 * itself rather than an end user — MCP tools attribute actions to users.
 */
export function authInfoFromPayload(
  payload: JWTPayload,
  bearerToken: string
): AuthInfo | undefined {
  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!sub) {
    return;
  }

  const clientId =
    (typeof payload.client_id === "string" && payload.client_id) ||
    (typeof payload.azp === "string" && payload.azp) ||
    undefined;

  // client_credentials (and similar) put the client id in `sub`. MCP is a
  // user-delegated resource — refuse those tokens rather than treating the
  // client id as a userId for attribution / get_me.
  if (clientId && sub === clientId) {
    return;
  }

  const scopeClaim = payload.scope ?? payload.scp;
  const scopes = Array.isArray(scopeClaim)
    ? scopeClaim.map(String)
    : typeof scopeClaim === "string"
      ? scopeClaim.split(/\s+/).filter(Boolean)
      : [];

  const expiresAt =
    typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp
      : undefined;

  return {
    token: bearerToken,
    clientId: clientId ?? "unknown",
    scopes,
    expiresAt,
    extra: { userId: sub },
  };
}
