import { describe, expect, it } from "vitest";
import { flattenPatScopes } from "@/lib/mcp/pat-scopes";

describe("flattenPatScopes", () => {
  it("always grants read", () => {
    expect(flattenPatScopes([])).toEqual(["read"]);
    expect(flattenPatScopes(["runs:read"])).toEqual(["read"]);
  });

  it("adds write only for wildcard", () => {
    expect(flattenPatScopes(["*"]).sort()).toEqual(["read", "write"]);
  });

  it("stays read-only for fine-grained mutating scopes", () => {
    // Mapping runs:comment → write would let that PAT delete runs over MCP.
    expect(flattenPatScopes(["runs:attribute"])).toEqual(["read"]);
    expect(flattenPatScopes(["files:reprocess"])).toEqual(["read"]);
    expect(flattenPatScopes(["instruments:write"])).toEqual(["read"]);
    expect(flattenPatScopes(["runs:read", "files:reprocess"])).toEqual([
      "read",
    ]);
  });

  it("stays read-only when every fine-grained action is read", () => {
    expect(
      flattenPatScopes(["runs:read", "files:read", "watchers:read"])
    ).toEqual(["read"]);
  });
});
