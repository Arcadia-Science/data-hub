/**
 * Map fine-grained PAT scopes onto the coarse OAuth pair used by MCP
 * transport (`read` / `write`). Always grant `read`; add `write` for `*` or
 * any scope whose action is not `read`.
 */
export function flattenPatScopes(scopes: string[]): string[] {
  const result = new Set<string>(["read"]);
  for (const scope of scopes) {
    if (scope === "*") {
      result.add("write");
      continue;
    }
    const colon = scope.indexOf(":");
    const action = colon === -1 ? scope : scope.slice(colon + 1);
    if (action !== "read") {
      result.add("write");
    }
  }
  return [...result];
}
