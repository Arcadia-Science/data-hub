import { apiError, FORBIDDEN } from "@/lib/api/errors";

// Canonical scope vocabulary. Each entry is `resource:action` and is added
// or revoked atomically — there are no implicit hierarchies (e.g. `:write`
// does not imply `:read`). The `*` wildcard is reserved for the migration
// backfill and for the watcher/Lambda PATs until they are rotated to
// least-privilege; `POST /api/v1/tokens` rejects it from API callers.
export const ALL_SCOPES = [
  "instruments:read",
  "instruments:write",
  "runs:read",
  "runs:write",
  "files:read",
  "files:write",
  "watchers:read",
  "watchers:write",
  "archive-jobs:read",
  "archive-jobs:write",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

// Pre-built set for O(1) membership checks in hot validation paths
// (`POST /api/v1/tokens`). Avoids re-scanning ALL_SCOPES on every request.
export const SCOPE_SET: Set<Scope> = new Set<Scope>(ALL_SCOPES);

// Shape required by `hasScope` / `requireScope`. We intentionally avoid
// importing the full `AuthResult` from `@/lib/api/auth` to break a circular
// dependency — scopes.ts is imported by auth.ts callers.
type AuthLike = { scopes: string[] };

export function hasScope(auth: AuthLike, required: Scope): boolean {
  return auth.scopes.includes("*") || auth.scopes.includes(required);
}

// Returns a `Response` to short-circuit the handler when the scope is
// missing, or `null` when the caller is authorized. Route handlers should
// use the pattern: `const scopeError = requireScope(auth, "runs:write");
// if (scopeError) return scopeError;`
export function requireScope(auth: AuthLike, required: Scope): Response | null {
  if (hasScope(auth, required)) return null;
  return apiError(
    403,
    FORBIDDEN,
    `Token is missing required scope: ${required}`
  );
}

// Validates the `scopes` field on a `POST /api/v1/tokens` request body.
// Returns the typed scope array on success, or an error message ready for
// the 400 response. Extracted from the route handler so the rules
// ("non-empty", "no wildcard", "valid vocabulary") can be unit-tested
// without spinning up the Next.js server, NextAuth, or the database.
//
// Rules enforced here:
//   - `scopes` must be an array with at least one entry.
//   - The wildcard `*` is rejected — it's reserved for the migration
//     backfill and the watcher/Lambda PATs; API callers must enumerate.
//   - Every entry must be a string in `SCOPE_SET`. Unknown / non-string
//     entries are reported in the error message verbatim so callers can
//     spot typos quickly.
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
