import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The helper memoizes `ADMIN_EMAILS` on first read for the lifetime of the
// process. Each test resets module state via `vi.resetModules()` and then
// imports the module fresh, exercising a different env value in isolation.
async function loadHelper(value: string | undefined) {
  if (value === undefined) {
    delete process.env.ADMIN_EMAILS;
  } else {
    process.env.ADMIN_EMAILS = value;
  }
  vi.resetModules();
  return await import("@/lib/admin-emails");
}

describe("admin-emails helper", () => {
  const originalEnv = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    delete process.env.ADMIN_EMAILS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = originalEnv;
    }
  });

  it("returns an empty set when ADMIN_EMAILS is unset", async () => {
    const { getAdminEmails, isAdminEmail } = await loadHelper(undefined);
    expect(getAdminEmails().size).toBe(0);
    expect(isAdminEmail("anyone@example.com")).toBe(false);
  });

  it("parses a single email", async () => {
    const { isAdminEmail } = await loadHelper("alice@arcadia.com");
    expect(isAdminEmail("alice@arcadia.com")).toBe(true);
    expect(isAdminEmail("bob@arcadia.com")).toBe(false);
  });

  it("parses a comma-separated list", async () => {
    const { getAdminEmails, isAdminEmail } = await loadHelper(
      "alice@arcadia.com,bob@arcadia.com,carol@arcadia.com"
    );
    expect(getAdminEmails().size).toBe(3);
    expect(isAdminEmail("alice@arcadia.com")).toBe(true);
    expect(isAdminEmail("bob@arcadia.com")).toBe(true);
    expect(isAdminEmail("carol@arcadia.com")).toBe(true);
  });

  it("treats comparisons as case-insensitive and trims whitespace", async () => {
    const { isAdminEmail } = await loadHelper(
      "  Alice@arcadia.com , bob@arcadia.com  "
    );
    expect(isAdminEmail("ALICE@arcadia.com")).toBe(true);
    expect(isAdminEmail("bob@ARCADIA.com")).toBe(true);
    expect(isAdminEmail("  bob@arcadia.com  ")).toBe(true);
    expect(isAdminEmail("carol@arcadia.com")).toBe(false);
  });

  it("rejects null / undefined / empty inputs", async () => {
    const { isAdminEmail } = await loadHelper("alice@arcadia.com");
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });

  it("ignores empty entries from leading/trailing/double commas", async () => {
    const { getAdminEmails } = await loadHelper(",,alice@arcadia.com,,");
    expect(getAdminEmails().size).toBe(1);
  });
});
