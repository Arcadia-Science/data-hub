import { describe, expect, it } from "vitest";
import { flattenPatScopes } from "@/lib/mcp/pat-scopes";

describe("flattenPatScopes", () => {
  it("always grants read", () => {
    expect(flattenPatScopes([])).toEqual(["read"]);
    expect(flattenPatScopes(["runs:read"])).toEqual(["read"]);
  });

  it("adds write for wildcard", () => {
    expect(flattenPatScopes(["*"]).sort()).toEqual(["read", "write"]);
  });

  it("adds write for any non-read action", () => {
    expect(flattenPatScopes(["runs:attribute"]).sort()).toEqual([
      "read",
      "write",
    ]);
    expect(flattenPatScopes(["files:reprocess"]).sort()).toEqual([
      "read",
      "write",
    ]);
    expect(flattenPatScopes(["instruments:write"]).sort()).toEqual([
      "read",
      "write",
    ]);
  });

  it("stays read-only when every fine-grained action is read", () => {
    expect(
      flattenPatScopes(["runs:read", "files:read", "watchers:read"])
    ).toEqual(["read"]);
  });

  it("grants write when any scope in a mixed list is mutating", () => {
    expect(flattenPatScopes(["runs:read", "files:reprocess"]).sort()).toEqual([
      "read",
      "write",
    ]);
  });
});
