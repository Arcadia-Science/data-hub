import { createHash, randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
// biome-ignore lint/performance/noNamespaceImport: tests need the full schema module for Db typing
import * as schema from "@/lib/db/schema";
import {
  clearAll,
  type SeedUserOptions,
  seedDevUser,
  seedSlackChannelConfig,
  seedWatcherReleaseConfig,
} from "@/lib/db/seed";

// ---------------------------------------------------------------------------
// Database — lazily initialized Drizzle client connected directly to the test
// DB. This bypasses the app's `@/lib/db` singleton (which reads DATABASE_URL
// at import time) and gives tests direct DB access for seeding and cleanup.
// ---------------------------------------------------------------------------

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _pool: Pool | null = null;

export function getTestDb() {
  if (!_db) {
    const url = process.env.__TEST_DATABASE_URL;
    if (!url) {
      throw new Error("__TEST_DATABASE_URL not set — global setup failed?");
    }
    _pool = new Pool({ connectionString: url });
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

export async function closeTestDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

// TRUNCATE every `pgTable` declared in `lib/db/schema.ts`, then re-seed
// singleton config rows with deterministic baselines. Tests previously
// hard-coded both the table list and the singleton SQL inline; both now
// live in `@/lib/db/seed` so adding a new table doesn't require touching
// this file.
//
// `clearAll` uses TRUNCATE CASCADE, which ignores the `ON DELETE SET NULL`
// on singleton `updated_by → user.id` FKs and wipes the rows regardless
// of whether they're in the TRUNCATE list. Re-seeding after the clear
// keeps every test's baseline identical to a fresh global setup.
export async function resetDb() {
  const db = getTestDb();
  await clearAll(db);
  await seedWatcherReleaseConfig(db);
  const captureBase = process.env.__TEST_SLACK_CAPTURE_URL;
  await seedSlackChannelConfig(
    db,
    captureBase ? `${captureBase}/webhook` : null
  );
}

// ---------------------------------------------------------------------------
// Auth seeding — thin wrapper around the shared `seedDevUser` builder in
// `@/lib/db/seed`. The shared builder is reused by `scripts/seed-database.ts`
// for the local-dev workflow, so test seeding and dev seeding share the
// same token-generation and admin-flag logic.
// ---------------------------------------------------------------------------

// Seeds a user + PAT directly in the database. Returns the plaintext token
// for use in `Authorization: Bearer dhub_...` headers. The server never
// stores the plaintext — only the SHA-256 hash — so we must generate the
// token here and pass it to both the DB (hashed) and the test (plaintext).
//
// Pass `expiresAt` to test expired-token rejection. Defaults to no expiry.
// Pass `scopes` to test scope enforcement; defaults to `["*"]` so every
// existing test (which expects full access) keeps passing.
// Pass `isAdmin` to seed a workspace admin row. The role only matters for
// session-authenticated routes (PAT requests never consult `user.is_admin`),
// but exposing the option here keeps the seeding helper future-proof for
// any cookie-based session test harness layered on later.
export async function seedTestUser(
  options?: Pick<
    SeedUserOptions,
    "expiresAt" | "scopes" | "isAdmin" | "name" | "email"
  >
) {
  const { userId, token, tokenId } = await seedDevUser(getTestDb(), {
    name: "Test User",
    ...options,
  });
  return { userId, token, tokenId };
}

function getAuthSecret(): string {
  const secret = process.env.__TEST_AUTH_SECRET;
  if (!secret) {
    throw new Error("__TEST_AUTH_SECRET not set — global setup failed?");
  }
  return secret;
}

/**
 * Seed a live session row and return a Cookie header Better Auth accepts.
 * Cookie name is `better-auth.session_token` (not `__Secure-…`) because the
 * test server's `BETTER_AUTH_URL` is `http://…` — Better Auth only prefixes
 * `__Secure-` when the base URL is HTTPS.
 */
export async function seedSessionCookie(userId: string): Promise<string> {
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
  const signature = await makeSignature(token, getAuthSecret());
  const signed = encodeURIComponent(`${token}.${signature}`);
  return `better-auth.session_token=${signed}`;
}

// ---------------------------------------------------------------------------
// API fetch wrapper — thin layer over native fetch that handles JSON
// serialization and Bearer token injection. All integration tests use this
// instead of raw fetch to keep test code focused on assertions.
// ---------------------------------------------------------------------------

type ApiOptions = Omit<RequestInit, "body"> & {
  token?: string;
  body?: unknown;
};

export function getBaseUrl(): string {
  const url = process.env.__TEST_BASE_URL;
  if (!url) {
    throw new Error("__TEST_BASE_URL not set — global setup failed?");
  }
  return url;
}

export async function api(
  path: string,
  options: ApiOptions = {}
): Promise<Response> {
  const { token, body, headers: extraHeaders, ...rest } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extraHeaders as Record<string, string>),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return await fetch(`${getBaseUrl()}${path}`, {
    ...rest,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Runs the real OAuth authorization-code + PKCE flow against the test server
 * and returns an MCP access token (a JWT) for `userId`. MCP does not accept
 * personal access tokens, so MCP integration tests sign in this way.
 *
 * `scope` is the space-separated MCP scope list the client requests and the
 * user consents to, for example `"read"` or `"read write"`.
 */
export async function getMcpAccessToken(
  userId: string,
  scope = "read write"
): Promise<string> {
  const baseUrl = getBaseUrl();
  const issuer = `${baseUrl}/api/auth`;
  const redirectUri = "http://127.0.0.1/callback";
  const oauthScope = `openid ${scope}`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  // The client is inserted directly because `/oauth2/register` is rate
  // limited per IP and the MCP suites share one server. The row mirrors what
  // a public PKCE client created by dynamic registration looks like;
  // authorize, consent, and token exchange below still run for real.
  const clientId = randomBytes(24).toString("base64url");
  await getTestDb()
    .insert(schema.oauthClients)
    .values({
      id: crypto.randomUUID(),
      clientId,
      name: "Integration Test MCP Client",
      redirectUris: [redirectUri],
      scopes: oauthScope.split(" "),
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      public: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

  const sessionCookie = await seedSessionCookie(userId);

  const authorizeUrl = new URL(`${issuer}/oauth2/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", oauthScope);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authorizeRes = await fetch(authorizeUrl, {
    headers: { Cookie: sessionCookie, Accept: "application/json" },
    redirect: "manual",
  });
  const authorizeBody = (await authorizeRes.json()) as { url?: string };
  if (!authorizeBody.url) {
    throw new Error("OAuth authorize returned no consent URL");
  }
  const consentUrl = new URL(authorizeBody.url, baseUrl);

  const consentRes = await fetch(`${issuer}/oauth2/consent`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      accept: true,
      scope: oauthScope,
      oauth_query: consentUrl.searchParams.toString(),
    }),
  });
  const consentBody = (await consentRes.json()) as {
    url?: string;
    redirect_uri?: string;
  };
  const codeRedirect = consentBody.url ?? consentBody.redirect_uri;
  const code = codeRedirect
    ? new URL(codeRedirect).searchParams.get("code")
    : null;
  if (!code) {
    throw new Error("OAuth consent returned no authorization code");
  }

  const tokenRes = await fetch(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      // Requesting the MCP resource makes the AS mint a JWT access token.
      resource: `${baseUrl}/mcp/v1`,
    }),
  });
  if (tokenRes.status !== 200) {
    throw new Error(`OAuth token exchange returned ${tokenRes.status}`);
  }
  const { access_token: accessToken } = (await tokenRes.json()) as {
    access_token: string;
  };
  return accessToken;
}

// ---------------------------------------------------------------------------
// Slack webhook capture — the global setup spawns an in-process HTTP server
// that captures every payload posted to the webhook URL stored in
// `slack_channel_config`. These helpers let individual tests inspect and
// reset that capture buffer.
// ---------------------------------------------------------------------------

function getSlackCaptureUrl(): string {
  const url = process.env.__TEST_SLACK_CAPTURE_URL;
  if (!url) {
    throw new Error("__TEST_SLACK_CAPTURE_URL not set — global setup failed?");
  }
  return url;
}

export async function getCapturedSlackMessages(): Promise<{ text: string }[]> {
  const res = await fetch(`${getSlackCaptureUrl()}/captured`);
  if (!res.ok) {
    throw new Error(`Slack capture /captured returned ${res.status}`);
  }
  return res.json();
}

/** Poll until at least `minCount` webhook payloads arrive or timeout. */
export async function waitForCapturedSlackMessages(
  minCount: number,
  { timeoutMs = 3000, intervalMs = 50 } = {}
): Promise<{ text: string }[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await getCapturedSlackMessages();
    if (messages.length >= minCount) {
      return messages;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${minCount} Slack webhook message(s)`);
}

export async function clearCapturedSlackMessages(): Promise<void> {
  const res = await fetch(`${getSlackCaptureUrl()}/clear`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Slack capture /clear returned ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Slack DM capture — mirrors the webhook helpers above but for
// chat.postMessage calls routed through the mock Slack Web API server.
// ---------------------------------------------------------------------------

function getSlackDmCaptureUrl(): string {
  const url = process.env.__TEST_SLACK_DM_CAPTURE_URL;
  if (!url) {
    throw new Error(
      "__TEST_SLACK_DM_CAPTURE_URL not set — global setup failed?"
    );
  }
  return url;
}

export interface CapturedSlackDm {
  blocks?: unknown[];
  channel: string;
  text: string;
}

export async function getCapturedSlackDms(): Promise<CapturedSlackDm[]> {
  const res = await fetch(`${getSlackDmCaptureUrl()}/dms/captured`);
  if (!res.ok) {
    throw new Error(`Slack DM capture /dms/captured returned ${res.status}`);
  }
  return res.json();
}

export async function clearCapturedSlackDms(): Promise<void> {
  const res = await fetch(`${getSlackDmCaptureUrl()}/dms/clear`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Slack DM capture /dms/clear returned ${res.status}`);
  }
}
