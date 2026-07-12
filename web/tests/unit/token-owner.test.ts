import { describe, expect, it, vi } from "vitest";
import { resolveTokenOwnerUserId } from "@/lib/api/token-owner";

// Owner resolution for `POST /api/v1/tokens`. Pure aside from the injected
// `userExists` check — unit-tested here because the integration harness has
// no session cookies and cannot hit the admin-only mint path over HTTP.

describe("resolveTokenOwnerUserId", () => {
  const callerId = "admin-user-id";

  it("defaults to the caller when user_id is omitted", async () => {
    const userExists = vi.fn();
    const result = await resolveTokenOwnerUserId(
      undefined,
      callerId,
      userExists
    );
    expect(result).toEqual({ ok: true, userId: callerId });
    expect(userExists).not.toHaveBeenCalled();
  });

  it("defaults to the caller when user_id is null", async () => {
    const userExists = vi.fn();
    const result = await resolveTokenOwnerUserId(null, callerId, userExists);
    expect(result).toEqual({ ok: true, userId: callerId });
    expect(userExists).not.toHaveBeenCalled();
  });

  it("returns a known user_id as the owner", async () => {
    const bobId = "bob-user-id";
    const userExists = vi.fn(async (id: string) => id === bobId);
    const result = await resolveTokenOwnerUserId(bobId, callerId, userExists);
    expect(result).toEqual({ ok: true, userId: bobId });
    expect(userExists).toHaveBeenCalledWith(bobId);
  });

  it("trims whitespace around user_id", async () => {
    const bobId = "bob-user-id";
    const userExists = vi.fn(async (id: string) => id === bobId);
    const result = await resolveTokenOwnerUserId(
      `  ${bobId}  `,
      callerId,
      userExists
    );
    expect(result).toEqual({ ok: true, userId: bobId });
  });

  it("rejects an unknown user_id", async () => {
    const userExists = vi.fn(async () => false);
    const result = await resolveTokenOwnerUserId(
      "missing-user",
      callerId,
      userExists
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/known user/);
    }
  });

  it("rejects a non-string user_id", async () => {
    const userExists = vi.fn();
    const result = await resolveTokenOwnerUserId(42, callerId, userExists);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/non-empty string/);
    }
    expect(userExists).not.toHaveBeenCalled();
  });

  it("rejects an empty or whitespace-only user_id", async () => {
    const userExists = vi.fn();
    for (const value of ["", "   "]) {
      const result = await resolveTokenOwnerUserId(value, callerId, userExists);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/non-empty string/);
      }
    }
    expect(userExists).not.toHaveBeenCalled();
  });
});
