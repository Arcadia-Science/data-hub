import { ALL_SCOPES, validateRequestedScopes } from "@/lib/api/scopes";
import { describe, expect, it } from "vitest";

// Validates the scope-list parsing rules used by `POST /api/v1/tokens`.
// These tests run with no DB / no Next.js server — `validateRequestedScopes`
// is a pure function. The HTTP wiring around it (auth check, DB insert) is
// trivial and exercised indirectly by the integration suite via the
// `seedTestUser` helper, which writes scopes through the same column.

describe("validateRequestedScopes", () => {
  it("rejects a missing scopes field", () => {
    const result = validateRequestedScopes(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-empty array/);
  });

  it("rejects a non-array scopes field", () => {
    const result = validateRequestedScopes("runs:read");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-empty array/);
  });

  it("rejects an empty array", () => {
    const result = validateRequestedScopes([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-empty array/);
  });

  it("rejects the wildcard '*' (reserved for backfill / watcher PATs)", () => {
    const result = validateRequestedScopes(["*"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/wildcard/);
  });

  it("rejects '*' even when mixed with valid scopes", () => {
    const result = validateRequestedScopes(["runs:read", "*"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/wildcard/);
  });

  it("rejects unknown scope names and reports them in the error", () => {
    const result = validateRequestedScopes(["runs:read", "bogus:read"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid scopes: bogus:read/);
      // The full vocabulary is enumerated so callers can spot typos.
      expect(result.error).toContain("runs:read");
      expect(result.error).toContain("files:write");
    }
  });

  it("rejects non-string entries", () => {
    const result = validateRequestedScopes(["runs:read", 42]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid scopes/);
  });

  it("accepts a single valid scope", () => {
    const result = validateRequestedScopes(["runs:read"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(["runs:read"]);
  });

  it("accepts a mix of read and write scopes across resources", () => {
    const requested = ["runs:read", "files:write", "watchers:read"];
    const result = validateRequestedScopes(requested);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(requested);
  });

  it("accepts every documented scope from ALL_SCOPES", () => {
    const result = validateRequestedScopes([...ALL_SCOPES]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toHaveLength(ALL_SCOPES.length);
  });
});
