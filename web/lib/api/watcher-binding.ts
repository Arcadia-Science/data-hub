import type { AuthResult } from "@/lib/api/auth";
import { SCOPE_PRESETS } from "@/lib/api/scope-catalog";
import {
  ALL_SCOPES,
  LEGACY_SCOPE_EXPANSIONS,
  type Scope,
} from "@/lib/api/scopes";

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

function watcherPresetScopes(): readonly Scope[] {
  const preset = SCOPE_PRESETS.find((candidate) => candidate.id === "watcher");
  if (!preset) {
    throw new Error("The Watcher scope preset is missing");
  }
  return preset.scopes;
}

// Every scope a watcher needs: the Watcher preset.
const WATCHER_SCOPES: ReadonlySet<Scope> = new Set(watcherPresetScopes());

function isLegacyScope(scope: string): boolean {
  return scope === "*" || Object.hasOwn(LEGACY_SCOPE_EXPANSIONS, scope);
}

/**
 * True when a token carries `*` or a coarse `:write` scope from before the
 * fine-grained split. New tokens can't, so only old tokens do.
 */
export function hasLegacyScope(scopes: readonly string[]): boolean {
  return scopes.some(isLegacyScope);
}

/**
 * The scopes a token that registered a watcher really has, given the scopes
 * stored on it. On such a token, `*` and each coarse `:write` scope count only
 * for the Watcher-preset scopes they used to imply, so an old watcher token
 * can't read every instrument's runs and files. Scopes the token lists
 * explicitly are kept, so the result never allows more than the stored scopes
 * did. Migration `0071_narrow_watcher_token_legacy_scopes` applied the same
 * rule once to the scopes stored then.
 */
export function narrowWatcherTokenScopes(scopes: readonly string[]): string[] {
  const kept = new Set<string>();
  for (const scope of scopes) {
    if (!isLegacyScope(scope)) {
      kept.add(scope);
      continue;
    }
    const implied = scope === "*" ? ALL_SCOPES : LEGACY_SCOPE_EXPANSIONS[scope];
    for (const impliedScope of implied) {
      if (WATCHER_SCOPES.has(impliedScope)) {
        kept.add(impliedScope);
      }
    }
  }
  // Known scopes in their usual order, then any the API no longer knows.
  const known: string[] = ALL_SCOPES.filter((scope) => kept.has(scope));
  return [...known, ...[...kept].filter((scope) => !known.includes(scope))];
}
