import type { AuthResult } from "@/lib/api/auth";

// Pure watcher↔PAT binding decision. Kept DB-free so the unit suite can
// import it without loading `@/lib/db` (which requires DATABASE_URL).

export type WatcherBindingVerdict = "allow" | "deny" | "tofu";

/**
 * Pure binding decision used by `enforceWatcherBinding` in `watchers.ts`.
 * Session/match/mismatch branches are unit-tested here; the TOFU claim path
 * and HTTP 403/200 behaviour live in the integration suite.
 *
 * Sessions deny so a future slip back to `authorize` cannot impersonate a
 * watcher. Agent routes themselves already use `authorizeToken`. A "deny" for
 * a token bound elsewhere is not final: see `isBoundToOtherToken`.
 */
export function decideWatcherBinding(
  authResult: AuthResult,
  registeredByToken: string | null
): WatcherBindingVerdict {
  if (authResult.authMethod === "session") {
    return "deny";
  }
  if (!authResult.tokenId) {
    return "deny";
  }
  if (registeredByToken === null) {
    return "tofu";
  }
  return registeredByToken === authResult.tokenId ? "allow" : "deny";
}

/**
 * True when a token caller meets a watcher bound to a different token. That
 * binding is only binding while the other token is active, so the caller must
 * check for revocation before giving up. Sessions and callers without a token
 * id are never in this case.
 */
export function isBoundToOtherToken(
  authResult: AuthResult,
  registeredByToken: string | null
): boolean {
  return (
    authResult.authMethod === "token" &&
    Boolean(authResult.tokenId) &&
    registeredByToken !== null &&
    registeredByToken !== authResult.tokenId
  );
}
