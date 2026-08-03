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

function isLoopbackAuthUrl(): boolean {
  const raw = process.env.BETTER_AUTH_URL;
  if (!raw) {
    return false;
  }
  try {
    const host = new URL(raw).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Dev/CI PAT Bearer fallback for MCP. Hard-off on Vercel production and on
 * self-hosted production (NODE_ENV=production with a non-loopback
 * BETTER_AUTH_URL). Local/CI `next start` keeps loopback URLs and stays allowed.
 */
export function isPatFallbackEnabled(): boolean {
  if (process.env.MCP_ALLOW_PAT_AUTH !== "true") {
    return false;
  }
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  if (process.env.NODE_ENV === "production" && !isLoopbackAuthUrl()) {
    return false;
  }
  return true;
}
