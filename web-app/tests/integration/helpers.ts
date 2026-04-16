import * as schema from "@/lib/db/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Database — lazily initialized Drizzle client connected directly to the test
// DB. This bypasses the app's `@/lib/db` singleton (which reads DATABASE_URL
// at import time) and gives tests direct DB access for seeding and cleanup.
// ---------------------------------------------------------------------------

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

export function getTestDb() {
  if (!_db) {
    const url = process.env.__TEST_DATABASE_URL;
    if (!url)
      throw new Error("__TEST_DATABASE_URL not set — global setup failed?");
    _client = postgres(url);
    _db = drizzle(_client, { schema });
  }
  return _db;
}

export async function closeTestDb() {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

// Tables listed leaf-first (children before parents) to satisfy FK constraints.
// CASCADE handles any ordering gaps, but explicit order avoids relying on it.
// Quoted names match Drizzle-generated tables that use camelCase identifiers.
const TRUNCATE_ORDER = [
  "run_report_data",
  "files",
  "instrument_runs",
  "watcher_events",
  "watcher_heartbeats",
  "watchers",
  "personal_access_tokens",
  "session",
  "account",
  "instruments",
  '"user"',
] as const;

export async function resetDb() {
  const db = getTestDb();
  for (const table of TRUNCATE_ORDER) {
    await db.execute(
      `TRUNCATE TABLE ${table} CASCADE` as unknown as Parameters<
        typeof db.execute
      >[0]
    );
  }
}

// ---------------------------------------------------------------------------
// Auth seeding — duplicates the token generation logic from @/lib/tokens
// rather than importing it. This avoids pulling in the app's module graph
// (which may trigger Next.js-specific side effects) into test workers.
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "dhub_";

function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("hex");
}

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function getTokenPrefix(plaintext: string): string {
  return plaintext.slice(0, TOKEN_PREFIX.length + 4);
}

// Seeds a user + PAT directly in the database. Returns the plaintext token
// for use in `Authorization: Bearer dhub_...` headers. The server never
// stores the plaintext — only the SHA-256 hash — so we must generate the
// token here and pass it to both the DB (hashed) and the test (plaintext).
//
// Pass `expiresAt` to test expired-token rejection. Defaults to no expiry.
export async function seedTestUser(options?: { expiresAt?: Date | null }) {
  const db = getTestDb();

  const userId = crypto.randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    name: "Test User",
    email: `test-${userId.slice(0, 8)}@example.com`,
  });

  const plaintext = generateToken();
  await db.insert(schema.personalAccessTokens).values({
    userId,
    name: "integration-test-token",
    tokenHash: hashToken(plaintext),
    tokenPrefix: getTokenPrefix(plaintext),
    expiresAt: options?.expiresAt !== undefined ? options.expiresAt : null,
  });

  return { userId, token: plaintext };
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
  if (!url) throw new Error("__TEST_BASE_URL not set — global setup failed?");
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
    headers["Authorization"] = `Bearer ${token}`;
  }

  return fetch(`${getBaseUrl()}${path}`, {
    ...rest,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
