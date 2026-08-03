/**
 * Map fine-grained PAT scopes onto the coarse OAuth pair used by MCP
 * (`read` / `write`).
 *
 * Always grant `read` for a valid PAT. Grant `write` only for the `*`
 * wildcard — mapping any mutating fine-grained scope (e.g. `runs:comment`)
 * to blanket MCP `write` would let that PAT delete runs / reprocess files
 * over MCP. Prefer OAuth consent for least-privilege write access; PAT
 * fallback is a dev/CI convenience.
 */
export function flattenPatScopes(scopes: string[]): string[] {
  const result = new Set<string>(["read"]);
  if (scopes.includes("*")) {
    result.add("write");
  }
  return [...result];
}
