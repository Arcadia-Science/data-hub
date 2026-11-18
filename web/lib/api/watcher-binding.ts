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

/** A watcher a token registered, as the ownership rules below need it. */
export interface RegisteredWatcher {
  deletedAt: Date | null;
  instrumentId: string;
}

/**
 * Whether a token may write to `instrumentId`, given every watcher the token
 * registered, deregistered ones included. A token that registered no watcher,
 * such as the Lambda's, may write to any instrument. A token that did may
 * write only to an instrument whose active watcher it registered, so a token
 * whose watchers were all deregistered may write to none.
 */
export function tokenMayActOnInstrument(
  registeredWatchers: readonly RegisteredWatcher[],
  instrumentId: string
): boolean {
  if (registeredWatchers.length === 0) {
    return true;
  }
  return registeredWatchers.some(
    (watcher) =>
      watcher.deletedAt === null && watcher.instrumentId === instrumentId
  );
}

/**
 * Whether a token may do an admin's work on instruments and watchers: rename,
 * retype, retire or confirm an instrument, or remove or reconfigure a
 * watcher. The watcher never does any of these, so a token that ever
 * registered a watcher may not, even for its own instrument. Any other token
 * may, if it has the scope.
 */
export function tokenMayAdminister(
  registeredWatchers: readonly RegisteredWatcher[]
): boolean {
  return registeredWatchers.length === 0;
}
