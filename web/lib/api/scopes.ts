// Canonical scope vocabulary. Each entry is `resource:action` and is granted
// or revoked atomically — there are no implicit hierarchies (e.g. `:write`
// does not imply `:read`, and `runs:reprocess` does not imply `runs:delete`).
// Actions are split finely so a token can carry the minimum a caller needs:
// reprocessing a run never drags along the ability to delete one.
export const ALL_SCOPES = [
  "instruments:read",
  "instruments:write",
  "runs:read",
  "runs:create",
  "runs:update",
  "runs:delete",
  "runs:reprocess",
  "runs:upload",
  "runs:attribute",
  "runs:comment",
  "files:read",
  "files:create",
  "files:update",
  "files:delete",
  "files:reprocess",
  "watchers:read",
  "watchers:report",
  "watchers:admin",
  "archive-jobs:read",
  "archive-jobs:write",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

// Pre-built set for O(1) membership checks in hot validation paths
// (`POST /api/v1/tokens`). Avoids re-scanning ALL_SCOPES on every request.
export const SCOPE_SET: Set<Scope> = new Set<Scope>(ALL_SCOPES);

// Coarse scopes minted before the fine-grained split, plus `*`. These are no
// longer offered when creating a token, but tokens already carrying them
// (deployed watchers, the Lambda, migration-backfilled PATs) must keep
// authorizing. `hasScope` expands them to the fine scopes they used to imply
// so nothing breaks before those tokens are rotated to least-privilege.
export const LEGACY_SCOPE_EXPANSIONS: Record<string, readonly Scope[]> = {
  "runs:write": [
    "runs:create",
    "runs:update",
    "runs:delete",
    "runs:reprocess",
    "runs:upload",
    "runs:attribute",
    "runs:comment",
  ],
  "files:write": [
    "files:create",
    "files:update",
    "files:delete",
    "files:reprocess",
  ],
  "watchers:write": ["watchers:report", "watchers:admin"],
};

// Shape required by `hasScope`. We intentionally avoid importing the full
// `AuthResult` from `@/lib/api/auth` to break a circular dependency —
// scopes.ts is imported by auth.ts callers.
interface AuthLike {
  scopes: string[];
}

export function hasScope(auth: AuthLike, required: Scope): boolean {
  if (auth.scopes.includes("*") || auth.scopes.includes(required)) {
    return true;
  }
  // A held legacy `:write` covers the fine scope it used to imply.
  return auth.scopes.some((held) =>
    LEGACY_SCOPE_EXPANSIONS[held]?.includes(required)
  );
}

// Validates the `scopes` field on a `POST /api/v1/tokens` request body.
// Returns the typed scope array on success, or an error message ready for
// the 400 response. Extracted from the route handler so the rules can be
// unit-tested without spinning up the Next.js server, NextAuth, or the DB.
//
// New tokens must enumerate fine scopes: the wildcard `*` and the legacy
// coarse `:write` scopes are rejected so freshly minted credentials are
// always least-privilege, even though `hasScope` still honors them on
// existing tokens.
export type ScopeValidationResult =
  | { ok: true; scopes: Scope[] }
  | { ok: false; error: string };

export function validateRequestedScopes(input: unknown): ScopeValidationResult {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "scopes must be a non-empty array" };
  }
  if (input.some((s) => s === "*")) {
    return {
      ok: false,
      error: "scopes must not include the wildcard '*' — list explicit scopes",
    };
  }
  const legacy = input.filter(
    (s): s is string => typeof s === "string" && s in LEGACY_SCOPE_EXPANSIONS
  );
  if (legacy.length > 0) {
    return {
      ok: false,
      error: `Deprecated coarse scopes are not allowed on new tokens: ${legacy.join(", ")}. Use the fine-grained scopes instead.`,
    };
  }
  const invalid = input.filter(
    (s): s is string => typeof s !== "string" || !SCOPE_SET.has(s as Scope)
  );
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid scopes: ${invalid.join(", ")}. Valid scopes: ${ALL_SCOPES.join(", ")}`,
    };
  }
  return { ok: true, scopes: input as Scope[] };
}
