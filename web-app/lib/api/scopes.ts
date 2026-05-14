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
  "archive-jobs:write",
  "mcp:read",
  "mcp:write",
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
