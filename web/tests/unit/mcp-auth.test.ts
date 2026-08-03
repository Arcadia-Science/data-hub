import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authInfoFromPayload,
  isPatFallbackEnabled,
} from "@/lib/mcp/auth-helpers";

describe("authInfoFromPayload", () => {
  it("maps a user JWT onto AuthInfo", () => {
    const info = authInfoFromPayload(
      {
        sub: "user-123",
        client_id: "mcp-client",
        scope: "openid read write",
        exp: 1_700_000_000,
      },
      "bearer.token.value"
    );
    expect(info).toEqual({
      token: "bearer.token.value",
      clientId: "mcp-client",
      scopes: ["openid", "read", "write"],
      expiresAt: 1_700_000_000,
      extra: { userId: "user-123" },
    });
  });

  it("accepts scp arrays and falls back to azp for clientId", () => {
    const info = authInfoFromPayload(
      {
        sub: "user-123",
        azp: "azp-client",
        scp: ["read", "write"],
      },
      "tok"
    );
    expect(info).toMatchObject({
      clientId: "azp-client",
      scopes: ["read", "write"],
      extra: { userId: "user-123" },
    });
    expect(info?.expiresAt).toBeUndefined();
  });

  it("uses unknown clientId and empty scopes when claims are absent", () => {
    const info = authInfoFromPayload({ sub: "user-123" }, "tok");
    expect(info).toEqual({
      token: "tok",
      clientId: "unknown",
      scopes: [],
      expiresAt: undefined,
      extra: { userId: "user-123" },
    });
  });

  it("ignores non-finite exp values", () => {
    const info = authInfoFromPayload(
      { sub: "user-123", client_id: "c", scope: "read", exp: Number.NaN },
      "tok"
    );
    expect(info?.expiresAt).toBeUndefined();
  });

  it("rejects client_credentials-style tokens where sub is the client", () => {
    expect(
      authInfoFromPayload(
        {
          sub: "client-abc",
          client_id: "client-abc",
          scope: "read",
        },
        "tok"
      )
    ).toBeUndefined();
    expect(
      authInfoFromPayload(
        {
          sub: "client-abc",
          azp: "client-abc",
          scope: "read",
        },
        "tok"
      )
    ).toBeUndefined();
  });

  it("rejects payloads without sub", () => {
    expect(
      authInfoFromPayload({ client_id: "c", scope: "read" }, "tok")
    ).toBeUndefined();
  });
});

describe("isPatFallbackEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires MCP_ALLOW_PAT_AUTH=true", () => {
    vi.stubEnv("MCP_ALLOW_PAT_AUTH", "false");
    vi.stubEnv("NODE_ENV", "development");
    expect(isPatFallbackEnabled()).toBe(false);
  });

  it("is hard-off when VERCEL_ENV=production", () => {
    vi.stubEnv("MCP_ALLOW_PAT_AUTH", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_URL", "https://datahub.example.com");
    expect(isPatFallbackEnabled()).toBe(false);
  });

  it("is hard-off for self-hosted production (non-loopback URL)", () => {
    vi.stubEnv("MCP_ALLOW_PAT_AUTH", "true");
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_URL", "https://datahub.example.com");
    expect(isPatFallbackEnabled()).toBe(false);
  });

  it("allows local/CI next start on loopback despite NODE_ENV=production", () => {
    vi.stubEnv("MCP_ALLOW_PAT_AUTH", "true");
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3000");
    expect(isPatFallbackEnabled()).toBe(true);
  });

  it("allows development", () => {
    vi.stubEnv("MCP_ALLOW_PAT_AUTH", "true");
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    expect(isPatFallbackEnabled()).toBe(true);
  });
});
