import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// biome-ignore lint/performance/noNamespaceImport: tests need the full schema module for Db typing
import * as schema from "@/lib/db/schema";
import {
  clearAll,
  type SeedUserOptions,
  seedDevUser,
  seedWatcherReleaseConfig,
} from "@/lib/db/seed";

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
    if (!url) {
      throw new Error("__TEST_DATABASE_URL not set — global setup failed?");
    }
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

// TRUNCATE every `pgTable` declared in `lib/db/schema.ts`, then re-seed
// the `watcher_release_config` singleton with the deterministic baseline
// `9.9.9 / 0.1.0 / stable / false`. Tests previously hard-coded both the
// table list and the singleton SQL inline; both now live in
// `@/lib/db/seed` so adding a new table doesn't require touching this
// file.
//
// `clearAll` uses TRUNCATE CASCADE, which ignores the `ON DELETE SET NULL`
// on `watcher_release_config.updated_by → user.id` and wipes the singleton
// regardless of whether it's in the TRUNCATE list. Re-seeding it after
// the clear keeps every test's update-check baseline identical to a
// fresh global setup.
export async function resetDb() {
  const db = getTestDb();
  await clearAll(db);
  await seedWatcherReleaseConfig(db);
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
  options?: Pick<SeedUserOptions, "expiresAt" | "scopes" | "isAdmin">
) {
  const { userId, token } = await seedDevUser(getTestDb(), {
    ...options,
    name: "Test User",
  });
  return { userId, token };
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

// ---------------------------------------------------------------------------
// Slack webhook capture — the global setup spawns an in-process HTTP server
// that captures every payload posted to SLACK_WEBHOOK_URL. These helpers let
// individual tests inspect and reset that capture buffer.
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
