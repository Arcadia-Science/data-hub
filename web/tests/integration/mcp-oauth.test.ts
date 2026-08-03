import { createHash, randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: integration tests need the full schema module for Db typing
import * as schema from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getBaseUrl,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// OAuth discovery + authorization-code end-to-end against MCP.
// Expected issuer / audience match `authIssuer` / `mcpResourceAudience`
// (`{BETTER_AUTH_URL}/api/auth` and `{BETTER_AUTH_URL}/mcp/v1`).

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

function getAuthSecret(): string {
  const secret = process.env.__TEST_AUTH_SECRET;
  if (!secret) {
    throw new Error("__TEST_AUTH_SECRET not set — global setup failed?");
  }
  return secret;
}

/** Sign a Better Auth session cookie value (`token.signature`, URI-encoded). */
async function signSessionCookieValue(token: string): Promise<string> {
  const signature = await makeSignature(token, getAuthSecret());
  return encodeURIComponent(`${token}.${signature}`);
}

/**
 * Seed a live session row and return a Cookie header Better Auth accepts.
 * Cookie name is `better-auth.session_token` (not `__Secure-…`) because the
 * test server's `BETTER_AUTH_URL` is `http://…` — Better Auth only prefixes
 * `__Secure-` when the base URL is HTTPS.
 */
async function seedSessionCookie(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  await getTestDb().insert(schema.sessions).values({
    id: crypto.randomUUID(),
    token,
    userId,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  const signed = await signSessionCookieValue(token);
  return `better-auth.session_token=${signed}`;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function parseSseResponse(res: Response) {
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) {
        return null;
      }
      return JSON.parse(dataLine.slice("data: ".length));
    })
    .filter(Boolean);
  return events.at(-1);
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
    // Challenge advertises every grantable scope; transport only *requires*
    // read.
    expect(challenge).toContain('scope="read write offline_access"');
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

  it("GET /.well-known/oauth-authorization-server/api/auth matches path-aware issuer metadata", async () => {
    // RFC 8414 path-aware discovery for issuer `{origin}/api/auth`.
    const res = await api("/.well-known/oauth-authorization-server/api/auth");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer?: string };
    expect(body.issuer).toBe(expectedIssuer());
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
      scopes_supported?: string[];
    };
    expect(body.resource).toBe(expectedMcpResource());
    expect(body.authorization_servers).toEqual([expectedIssuer()]);
    expect(body.scopes_supported).toEqual(["read", "write", "offline_access"]);
  });

  it("GET /.well-known/oauth-protected-resource/mcp/v1 matches path-specific metadata", async () => {
    const res = await api("/.well-known/oauth-protected-resource/mcp/v1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    expect(body.resource).toBe(expectedMcpResource());
    expect(body.authorization_servers).toEqual([expectedIssuer()]);
    expect(body.scopes_supported).toEqual(["read", "write", "offline_access"]);
  });
});

describe("MCP OAuth authorization-code flow", () => {
  const instrumentId = "mcp-oauth-e2e-instrument";
  let userId: string;

  beforeAll(async () => {
    await resetDb();
    ({ userId } = await seedTestUser());
    await getTestDb().insert(schema.instruments).values({
      id: instrumentId,
      displayName: "MCP OAuth E2E Instrument",
      status: "active",
      instrumentType: "plate_reader",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("registers a public client, consents, exchanges code, and calls MCP", async () => {
    const baseUrl = getBaseUrl();
    const issuer = expectedIssuer();
    const resource = expectedMcpResource();
    const redirectUri = "http://127.0.0.1/callback";
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("hex");

    // 1. Dynamic client registration (public / PKCE).
    const registerRes = await api("/api/auth/oauth2/register", {
      method: "POST",
      body: {
        client_name: "E2E MCP Test Client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid profile email offline_access read write",
      },
    });
    expect(registerRes.status).toBe(200);
    const registered = (await registerRes.json()) as {
      client_id?: string;
    };
    expect(registered.client_id).toBeTruthy();
    const clientId = registered.client_id as string;

    // 2. Seed a session cookie (email/password is disabled under `next start`).
    const sessionCookie = await seedSessionCookie(userId);

    // 3. Authorize → consent redirect with signed oauth_query.
    const authorizeUrl = new URL(`${issuer}/oauth2/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set(
      "scope",
      "openid profile email offline_access read write"
    );
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeRes = await fetch(authorizeUrl, {
      method: "GET",
      headers: {
        Cookie: sessionCookie,
        Accept: "application/json",
      },
      redirect: "manual",
    });
    expect(authorizeRes.status).toBe(200);
    const authorizeBody = (await authorizeRes.json()) as {
      redirect?: boolean;
      url?: string;
    };
    expect(authorizeBody.redirect).toBe(true);
    expect(authorizeBody.url).toBeTruthy();
    const consentUrl = new URL(authorizeBody.url as string, baseUrl);
    expect(consentUrl.pathname).toBe("/consent");
    expect(consentUrl.searchParams.get("client_id")).toBe(clientId);
    expect(consentUrl.searchParams.get("sig")).toBeTruthy();

    // Consent page reads redirect_uris from the DB (public-client omits them).
    const [storedClient] = await getTestDb()
      .select({
        name: schema.oauthClients.name,
        redirectUris: schema.oauthClients.redirectUris,
      })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId))
      .limit(1);
    expect(storedClient?.name).toBe("E2E MCP Test Client");
    expect(storedClient?.redirectUris).toContain(redirectUri);

    // 4. Consent → authorization code.
    const oauthQuery = consentUrl.searchParams.toString();
    const consentRes = await fetch(`${issuer}/oauth2/consent`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        accept: true,
        scope: "openid profile email offline_access read write",
        oauth_query: oauthQuery,
      }),
    });
    expect(consentRes.status).toBe(200);
    const consentBody = (await consentRes.json()) as {
      redirect?: boolean;
      url?: string;
      redirect_uri?: string;
    };
    const codeRedirect =
      consentBody.url ?? consentBody.redirect_uri ?? undefined;
    expect(codeRedirect).toBeTruthy();
    const codeUrl = new URL(codeRedirect as string);
    expect(codeUrl.searchParams.get("state")).toBe(state);
    const code = codeUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    // 5. Exchange code for a JWT access token (resource → JWT audience).
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: code as string,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    });
    const tokenRes = await fetch(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: tokenBody,
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
    };
    expect(tokens.token_type?.toLowerCase()).toBe("bearer");
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.scope).toMatch(/\bread\b/);
    expect(tokens.scope).toMatch(/\bwrite\b/);
    // JWT (three segments) when `resource` is requested.
    expect(tokens.access_token?.split(".").length).toBe(3);

    // 6. Call MCP with the OAuth access token.
    const mcpRes = await api("/mcp/v1", {
      method: "POST",
      token: tokens.access_token,
      headers: MCP_HEADERS,
      body: jsonRpc("tools/call", {
        name: "list_instruments",
        arguments: {},
      }),
    });
    expect(mcpRes.status).toBe(200);
    const mcpData = await parseSseResponse(mcpRes);
    expect(mcpData.result?.isError).toBeFalsy();
    const payload = JSON.parse(mcpData.result.content[0].text) as Array<{
      id: string;
    }>;
    expect(payload.some((row) => row.id === instrumentId)).toBe(true);
  });

  it("DCR without scope body still allows authorize with read write", async () => {
    // Cursor registers without `scope`, then requests `read write` from the
    // WWW-Authenticate challenge. The client's stored scopes must include write
    // or authorize redirects with invalid_scope.
    const issuer = expectedIssuer();
    const redirectUri = "http://127.0.0.1:8787/callback";
    const { challenge } = pkcePair();

    const registerRes = await api("/api/auth/oauth2/register", {
      method: "POST",
      body: {
        client_name: "Cursor-like MCP Client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
    });
    expect(registerRes.status).toBe(200);
    const { client_id: clientId } = (await registerRes.json()) as {
      client_id: string;
    };

    const sessionCookie = await seedSessionCookie(userId);
    const authorizeUrl = new URL(`${issuer}/oauth2/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "read write");
    authorizeUrl.searchParams.set("resource", expectedMcpResource());
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeRes = await fetch(authorizeUrl, {
      headers: { Cookie: sessionCookie, Accept: "application/json" },
      redirect: "manual",
    });
    expect(authorizeRes.status).toBe(200);
    const authorizeBody = (await authorizeRes.json()) as {
      redirect?: boolean;
      url?: string;
    };
    expect(authorizeBody.redirect).toBe(true);
    expect(authorizeBody.url).toBeTruthy();
    const consentUrl = new URL(authorizeBody.url as string, getBaseUrl());
    expect(consentUrl.pathname).toBe("/consent");
    expect(consentUrl.searchParams.get("error")).toBeNull();
    expect(consentUrl.search).not.toMatch(/invalid_scope/);
  });

  it("DCR with the advertised scopes allows authorize with offline_access", async () => {
    // Claude Code registers with the scopes it read from protected-resource
    // metadata, then appends `offline_access` to the authorize request because
    // the AS advertises it. Both lists must agree or authorize redirects with
    // invalid_scope.
    const issuer = expectedIssuer();
    const redirectUri = "http://127.0.0.1:8788/callback";
    const { challenge } = pkcePair();

    const prmRes = await api("/.well-known/oauth-protected-resource/mcp/v1");
    const { scopes_supported: advertisedScopes } = (await prmRes.json()) as {
      scopes_supported: string[];
    };
    expect(advertisedScopes).toContain("offline_access");

    const registerRes = await api("/api/auth/oauth2/register", {
      method: "POST",
      body: {
        client_name: "Claude-Code-like MCP Client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: advertisedScopes.join(" "),
      },
    });
    expect(registerRes.status).toBe(200);
    const { client_id: clientId } = (await registerRes.json()) as {
      client_id: string;
    };

    const sessionCookie = await seedSessionCookie(userId);
    const authorizeUrl = new URL(`${issuer}/oauth2/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "read write offline_access");
    authorizeUrl.searchParams.set("prompt", "consent");
    authorizeUrl.searchParams.set("resource", expectedMcpResource());
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeRes = await fetch(authorizeUrl, {
      headers: { Cookie: sessionCookie, Accept: "application/json" },
      redirect: "manual",
    });
    expect(authorizeRes.status).toBe(200);
    const authorizeBody = (await authorizeRes.json()) as {
      redirect?: boolean;
      url?: string;
    };
    expect(authorizeBody.redirect).toBe(true);
    const consentUrl = new URL(authorizeBody.url as string, getBaseUrl());
    expect(consentUrl.pathname).toBe("/consent");
    expect(consentUrl.searchParams.get("error")).toBeNull();
    expect(consentUrl.search).not.toMatch(/invalid_scope/);
  });

  it("read-only OAuth token can read but not mutate via MCP", async () => {
    const issuer = expectedIssuer();
    const resource = expectedMcpResource();
    const redirectUri = "http://127.0.0.1/callback-readonly";
    const { verifier, challenge } = pkcePair();

    const registerRes = await api("/api/auth/oauth2/register", {
      method: "POST",
      body: {
        client_name: "E2E Read-Only Client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "openid read",
      },
    });
    expect(registerRes.status).toBe(200);
    const { client_id: clientId } = (await registerRes.json()) as {
      client_id: string;
    };

    const sessionCookie = await seedSessionCookie(userId);

    const authorizeUrl = new URL(`${issuer}/oauth2/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "openid read");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeRes = await fetch(authorizeUrl, {
      headers: { Cookie: sessionCookie, Accept: "application/json" },
    });
    const authorizeBody = (await authorizeRes.json()) as { url?: string };
    const consentUrl = new URL(authorizeBody.url as string, getBaseUrl());

    const consentRes = await fetch(`${issuer}/oauth2/consent`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        accept: true,
        scope: "openid read",
        oauth_query: consentUrl.searchParams.toString(),
      }),
    });
    const consentBody = (await consentRes.json()) as {
      url?: string;
      redirect_uri?: string;
    };
    const code = new URL(
      (consentBody.url ?? consentBody.redirect_uri) as string
    ).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await fetch(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code as string,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token: accessToken } = (await tokenRes.json()) as {
      access_token: string;
    };

    const listRes = await api("/mcp/v1", {
      method: "POST",
      token: accessToken,
      headers: MCP_HEADERS,
      body: jsonRpc("tools/call", {
        name: "list_instruments",
        arguments: {},
      }),
    });
    expect(listRes.status).toBe(200);
    const listData = await parseSseResponse(listRes);
    expect(listData.result?.isError).toBeFalsy();

    // Transport allows read-only; write tools reject at requireMcpWrite.
    const claimRes = await api("/mcp/v1", {
      method: "POST",
      token: accessToken,
      headers: MCP_HEADERS,
      body: jsonRpc("tools/call", {
        name: "claim_run",
        arguments: { instrumentId, runId: "does-not-matter" },
      }),
    });
    expect(claimRes.status).toBe(200);
    const claimData = await parseSseResponse(claimRes);
    expect(claimData.result?.isError).toBe(true);
    expect(claimData.result.content[0].text).toMatch(
      /missing required scope: write/
    );
  });
});
