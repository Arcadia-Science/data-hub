import { describe, expect, it } from "vitest";
import {
  ALL_SCOPES,
  hasScope,
  validateRequestedScopes,
} from "@/lib/api/scopes";

// Validates the scope-list parsing rules used by `POST /api/v1/tokens`.
// These tests run with no DB / no Next.js server — `validateRequestedScopes`
// is a pure function. The HTTP wiring around it (auth check, DB insert) is
// trivial and exercised indirectly by the integration suite via the
// `seedTestUser` helper, which writes scopes through the same column.

describe("validateRequestedScopes", () => {
  it("rejects a missing scopes field", () => {
    const result = validateRequestedScopes(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/non-empty array/);
    }
  });

  it("rejects a non-array scopes field", () => {
    const result = validateRequestedScopes("runs:read");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/non-empty array/);
    }
  });

  it("rejects an empty array", () => {
    const result = validateRequestedScopes([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/non-empty array/);
    }
  });

  it("rejects the wildcard '*' (reserved for backfill / watcher PATs)", () => {
    const result = validateRequestedScopes(["*"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/wildcard/);
    }
  });

  it("rejects '*' even when mixed with valid scopes", () => {
    const result = validateRequestedScopes(["runs:read", "*"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/wildcard/);
    }
  });

  it("rejects unknown scope names and reports them in the error", () => {
    const result = validateRequestedScopes(["runs:read", "bogus:read"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid scopes: bogus:read/);
      // The full vocabulary is enumerated so callers can spot typos.
      expect(result.error).toContain("runs:read");
      expect(result.error).toContain("files:reprocess");
    }
  });

  it("rejects deprecated coarse '*:write' scopes on new tokens", () => {
    const result = validateRequestedScopes(["runs:write"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Deprecated coarse scopes/);
      expect(result.error).toContain("runs:write");
    }
  });

  it("rejects non-string entries", () => {
    const result = validateRequestedScopes(["runs:read", 42]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid scopes/);
    }
  });

  it("accepts a single valid scope", () => {
    const result = validateRequestedScopes(["runs:read"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toEqual(["runs:read"]);
    }
  });

  it("accepts a mix of read and write scopes across resources", () => {
    const requested = ["runs:read", "files:reprocess", "watchers:read"];
    const result = validateRequestedScopes(requested);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toEqual(requested);
    }
  });

  it("accepts every documented scope from ALL_SCOPES", () => {
    const result = validateRequestedScopes([...ALL_SCOPES]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toHaveLength(ALL_SCOPES.length);
    }
  });
});

// `hasScope` is the runtime gate every route calls. Beyond exact matches it
// honors the wildcard and expands legacy coarse `:write` scopes so tokens
// minted before the fine-grained split keep working.
describe("hasScope", () => {
  it("matches an exactly-granted fine scope", () => {
    expect(hasScope({ scopes: ["runs:reprocess"] }, "runs:reprocess")).toBe(
      true
    );
  });

  it("does not imply other actions on the same resource", () => {
    expect(hasScope({ scopes: ["runs:reprocess"] }, "runs:delete")).toBe(false);
    expect(hasScope({ scopes: ["files:read"] }, "files:delete")).toBe(false);
  });

  it("wildcard grants everything", () => {
    for (const scope of ALL_SCOPES) {
      expect(hasScope({ scopes: ["*"] }, scope)).toBe(true);
    }
  });

  it("expands a legacy 'runs:write' to its fine actions", () => {
    for (const scope of [
      "runs:create",
      "runs:update",
      "runs:delete",
      "runs:reprocess",
      "runs:upload",
      "runs:attribute",
      "runs:comment",
    ] as const) {
      expect(hasScope({ scopes: ["runs:write"] }, scope)).toBe(true);
    }
    // Expansion is scoped to the same resource — it never leaks reads or
    // other resources.
    expect(hasScope({ scopes: ["runs:write"] }, "runs:read")).toBe(false);
    expect(hasScope({ scopes: ["runs:write"] }, "files:create")).toBe(false);
  });

  it("expands legacy 'files:write' and 'watchers:write'", () => {
    expect(hasScope({ scopes: ["files:write"] }, "files:delete")).toBe(true);
    expect(hasScope({ scopes: ["watchers:write"] }, "watchers:admin")).toBe(
      true
    );
    expect(hasScope({ scopes: ["watchers:write"] }, "watchers:report")).toBe(
      true
    );
  });
});
