import { beforeEach, describe, expect, it, vi } from "vitest";

// Opaque OAuth access-token DB lookup was removed (JWT-only), and so was the
// personal access token fallback. These tests cover `verifyMcpToken`: JWT
// verify → `authInfoFromPayload`, and that `dhub_` tokens never reach the
// token table.

const { mockVerifyAccessToken, mockAuthenticateWithToken } = vi.hoisted(() => ({
  mockVerifyAccessToken: vi.fn(),
  mockAuthenticateWithToken: vi.fn(),
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

import { verifyMcpToken } from "@/lib/mcp/auth";

describe("verifyMcpToken", () => {
  beforeEach(() => {
    mockVerifyAccessToken.mockReset();
    mockAuthenticateWithToken.mockReset();
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

  it("does not accept dhub_ personal access tokens", async () => {
    mockVerifyAccessToken.mockRejectedValue(new Error("JWSInvalid"));
    mockAuthenticateWithToken.mockResolvedValue({
      userId: "pat-user",
      scopes: ["*"],
    });

    await expect(
      verifyMcpToken(
        new Request("http://localhost/mcp/v1", {
          headers: { Authorization: "Bearer dhub_testtoken" },
        }),
        "dhub_testtoken"
      )
    ).resolves.toBeUndefined();
    expect(mockAuthenticateWithToken).not.toHaveBeenCalled();
  });
});
