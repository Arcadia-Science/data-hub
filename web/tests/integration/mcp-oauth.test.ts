import { describe, expect, it } from "vitest";
import { api, getBaseUrl } from "@/tests/integration/helpers";

// OAuth discovery + unauthenticated MCP challenge. Expected issuer /
// audience match `authIssuer` / `mcpResourceAudience` in `lib/auth.ts`
// (`{BETTER_AUTH_URL}/api/auth` and `{BETTER_AUTH_URL}/mcp/v1`). The test
// server sets BETTER_AUTH_URL to `__TEST_BASE_URL`.

function jsonRpc(method: string, params: unknown = {}, id = 1) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method,
    params,
  };
}

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
};

function expectedIssuer(): string {
  return `${getBaseUrl()}/api/auth`;
}

function expectedMcpResource(): string {
  return `${getBaseUrl()}/mcp/v1`;
}

describe("MCP OAuth discovery", () => {
  it("unauthenticated POST /mcp/v1 returns 401 with resource_metadata challenge", async () => {
    const res = await api("/mcp/v1", {
      method: "POST",
      headers: MCP_HEADERS,
      body: jsonRpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer\b/i);
    expect(challenge).toContain("error=");
    expect(challenge).toContain(
      `resource_metadata="${getBaseUrl()}/.well-known/oauth-protected-resource/mcp/v1"`
    );
  });

  it("GET /.well-known/oauth-authorization-server advertises issuer and registration", async () => {
    const res = await api("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer?: string;
      registration_endpoint?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    const issuer = expectedIssuer();
    expect(body.issuer).toBe(issuer);
    expect(body.registration_endpoint).toBe(`${issuer}/oauth2/register`);
    expect(body.authorization_endpoint).toBe(`${issuer}/oauth2/authorize`);
    expect(body.token_endpoint).toBe(`${issuer}/oauth2/token`);
  });

  it("GET /.well-known/openid-configuration advertises issuer and registration", async () => {
    const res = await api("/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer?: string;
      registration_endpoint?: string;
      userinfo_endpoint?: string;
    };
    const issuer = expectedIssuer();
    expect(body.issuer).toBe(issuer);
    expect(body.registration_endpoint).toBe(`${issuer}/oauth2/register`);
    expect(body.userinfo_endpoint).toBe(`${issuer}/oauth2/userinfo`);
  });

  it("GET /.well-known/oauth-protected-resource points at MCP audience", async () => {
    const res = await api("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource?: string;
      authorization_servers?: string[];
    };
    expect(body.resource).toBe(expectedMcpResource());
    expect(body.authorization_servers).toEqual([expectedIssuer()]);
  });

  it("GET /.well-known/oauth-protected-resource/mcp/v1 matches path-specific metadata", async () => {
    const res = await api("/.well-known/oauth-protected-resource/mcp/v1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource?: string;
      authorization_servers?: string[];
    };
    expect(body.resource).toBe(expectedMcpResource());
    expect(body.authorization_servers).toEqual([expectedIssuer()]);
  });
});
