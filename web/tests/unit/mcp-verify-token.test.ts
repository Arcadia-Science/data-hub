import { beforeEach, describe, expect, it, vi } from "vitest";

// Opaque OAuth access-token DB lookup was removed (JWT-only). These tests
// cover the remaining orchestration in `verifyMcpToken`: JWT verify →
// `authInfoFromPayload`, and the `dhub_` PAT short-circuit.

const {
  mockVerifyAccessToken,
  mockAuthenticateWithToken,
  mockIsPatFallbackEnabled,
} = vi.hoisted(() => ({
  mockVerifyAccessToken: vi.fn(),
  mockAuthenticateWithToken: vi.fn(),
  mockIsPatFallbackEnabled: vi.fn(),
}));

vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({
    verifyAccessToken: mockVerifyAccessToken,
  }),
}));

vi.mock("@better-auth/oauth-provider/resource-client", () => ({
  oauthProviderResourceClient: () => ({}),
}));

vi.mock("@/lib/auth", () => ({
  authBaseURL: "http://localhost:3000",
  authInstance: {},
  authIssuer: "http://localhost:3000/api/auth",
  mcpResourceAudience: "http://localhost:3000/mcp/v1",
}));

vi.mock("@/lib/api/auth", () => ({
  authenticateWithToken: mockAuthenticateWithToken,
}));

vi.mock("@/lib/mcp/auth-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mcp/auth-helpers")>();
  return {
    ...actual,
    isPatFallbackEnabled: mockIsPatFallbackEnabled,
  };
});

import { verifyMcpToken } from "@/lib/mcp/auth";

describe("verifyMcpToken", () => {
  beforeEach(() => {
    mockVerifyAccessToken.mockReset();
    mockAuthenticateWithToken.mockReset();
    mockIsPatFallbackEnabled.mockReset();
    mockIsPatFallbackEnabled.mockReturnValue(false);
  });

  it("returns undefined without a bearer token", async () => {
    await expect(
      verifyMcpToken(new Request("http://localhost/mcp/v1"))
    ).resolves.toBeUndefined();
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it("maps a verified JWT payload onto AuthInfo", async () => {
    mockVerifyAccessToken.mockResolvedValue({
      sub: "user-1",
      client_id: "client-1",
      scope: "read write",
      exp: 1_800_000_000,
    });

    const info = await verifyMcpToken(
      new Request("http://localhost/mcp/v1"),
      "a.b.c"
    );

    expect(info).toEqual({
      token: "a.b.c",
      clientId: "client-1",
      scopes: ["read", "write"],
      expiresAt: 1_800_000_000,
      extra: { userId: "user-1" },
    });
    expect(mockAuthenticateWithToken).not.toHaveBeenCalled();
  });

  it("rejects verified JWTs that look like client_credentials", async () => {
    mockVerifyAccessToken.mockResolvedValue({
      sub: "client-1",
      client_id: "client-1",
      scope: "read",
    });

    await expect(
      verifyMcpToken(new Request("http://localhost/mcp/v1"), "a.b.c")
    ).resolves.toBeUndefined();
  });

  it("returns undefined when JWT verification fails", async () => {
    mockVerifyAccessToken.mockRejectedValue(new Error("invalid access token"));

    await expect(
      verifyMcpToken(new Request("http://localhost/mcp/v1"), "not-a-jwt")
    ).resolves.toBeUndefined();
    expect(mockAuthenticateWithToken).not.toHaveBeenCalled();
  });

  it("short-circuits dhub_ PATs when fallback is enabled", async () => {
    mockIsPatFallbackEnabled.mockReturnValue(true);
    mockAuthenticateWithToken.mockResolvedValue({
      userId: "pat-user",
      scopes: ["*"],
    });

    const req = new Request("http://localhost/mcp/v1", {
      headers: { Authorization: "Bearer dhub_testtoken" },
    });
    const info = await verifyMcpToken(req, "dhub_testtoken");

    expect(info).toEqual({
      token: "dhub_testtoken",
      clientId: "pat-user",
      scopes: ["read", "write"],
      extra: { userId: "pat-user" },
    });
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it("keeps fine-grained PAT scopes read-only over MCP", async () => {
    mockIsPatFallbackEnabled.mockReturnValue(true);
    mockAuthenticateWithToken.mockResolvedValue({
      userId: "pat-user",
      scopes: ["runs:comment"],
    });

    const info = await verifyMcpToken(
      new Request("http://localhost/mcp/v1"),
      "dhub_scoped"
    );

    expect(info?.scopes).toEqual(["read"]);
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it("does not treat non-dhub tokens as PATs even when fallback is on", async () => {
    mockIsPatFallbackEnabled.mockReturnValue(true);
    mockVerifyAccessToken.mockRejectedValue(new Error("JWSInvalid"));

    await expect(
      verifyMcpToken(new Request("http://localhost/mcp/v1"), "opaque-or-junk")
    ).resolves.toBeUndefined();
    expect(mockAuthenticateWithToken).not.toHaveBeenCalled();
  });

  it("returns undefined for an unrecognized PAT", async () => {
    mockIsPatFallbackEnabled.mockReturnValue(true);
    mockAuthenticateWithToken.mockResolvedValue(null);

    await expect(
      verifyMcpToken(new Request("http://localhost/mcp/v1"), "dhub_missing")
    ).resolves.toBeUndefined();
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });
});
