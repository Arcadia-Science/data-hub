// Everything the screenshot run starts and stops: the throwaway database, the
// local file mirror, and a dev server with its own output folder. It uses
// `next dev` because the local file mirror, which serves the gel images, PDFs,
// and plate maps, is switched off in production builds.

import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSignature } from "better-auth/crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { CREATE_NATURAL_FILENAME_COLLATION } from "@/lib/db/collations";
import { sessions } from "@/lib/db/schema";
import { SESSION_COOKIE_NAME } from "./constants";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = path.resolve(SCRIPT_DIR, "..", "..");
export const REPO_DIR = path.resolve(WEB_DIR, "..");
export const WORK_DIR = path.join(WEB_DIR, ".docs-screenshots");
export const MIRROR_DIR = path.join(WORK_DIR, "s3");
const PID_FILE = path.join(WORK_DIR, "server.pid");
const NEXT_BIN = path.join(
  WEB_DIR,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);

const DEFAULT_PG_URL = "postgres://postgres:postgres@127.0.0.1:5432";
export const DATABASE_NAME = "data_hub_screenshots";

// Files in `web/` that `next dev` edits when it starts.
const REWRITTEN_BY_NEXT = ["next-env.d.ts", "tsconfig.json", "AGENTS.md"];

// Fixed so repeat runs show the same dates and times regardless of the
// machine's own time zone. The browser context uses the same one.
export const TIME_ZONE = "America/Los_Angeles";

// Not secret: this server only ever holds seeded data on a loopback port.
const AUTH_SECRET = "docs-screenshots-secret-at-least-32-characters";
const INTEGRATION_SECRETS_KEY = "b".repeat(64);

export function postgresUrl(): string {
  return process.env.DOCS_SCREENSHOTS_PG_URL ?? DEFAULT_PG_URL;
}

export function databaseUrl(): string {
  return `${postgresUrl()}/${DATABASE_NAME}`;
}

// Drops and recreates the schema instead of the whole database so a running
// `psql` session or a leftover connection can't block the reset.
export async function resetDatabase(): Promise<void> {
  const admin = new Client({ connectionString: `${postgresUrl()}/postgres` });
  await admin.connect();
  try {
    const existing = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [DATABASE_NAME]
    );
    if (existing.rows.length === 0) {
      // CREATE DATABASE can't take parameters; the name is a constant above.
      await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);
    }
  } finally {
    await admin.end();
  }

  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    // Push installs neither the trigram extension nor the filename collation
    // that the schema's indexes need.
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await client.query(CREATE_NATURAL_FILENAME_COLLATION);
  } finally {
    await client.end();
  }

  execSync("npx drizzle-kit push --force", {
    cwd: WEB_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl() },
    stdio: "pipe",
  });
}

export function resetMirror(): void {
  rmSync(MIRROR_DIR, { recursive: true, force: true });
  mkdirSync(MIRROR_DIR, { recursive: true });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Could not get a free port"));
      }
    });
    server.on("error", reject);
  });
}

export interface DevServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

// Variables the developer's own `web/.env` might set. Next.js never overrides a
// variable that is already defined, so an empty value keeps them out.
const BLANKED_ENV = [
  "ADMIN_EMAILS",
  "AWS_ROLE_ARN",
  "AWS_SESSION_TOKEN",
  "CRON_SECRET",
  "DISHCAM_LOCAL_PREVIEW_DIR",
  "LAMBDA_FUNCTION_URL",
  "LAMBDA_INVOKE_TOKEN",
  "MCP_ALLOW_PAT_AUTH",
  "OAUTH_PROXY_SECRET",
  "OAUTH_PROXY_URL",
  "S3_ARCHIVES_BUCKET",
  "SLACK_BOT_TOKEN",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_REDIRECT_URI",
  "SLACK_STATE_SECRET",
  "SLACK_TEAM_ID",
  "STALLED_PROCESSING_AFTER_MINUTES",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
] as const;

async function waitForServer(url: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The dev server did not answer at ${url} in time`);
}

// Puts the files `next dev` rewrote back from their backups. Backups are kept
// until `deleteBackups` is set, so the files can be restored a second time.
function restoreFiles(deleteBackups: boolean): void {
  for (const name of REWRITTEN_BY_NEXT) {
    const backup = path.join(WORK_DIR, `${name}.bak`);
    if (!existsSync(backup)) {
      continue;
    }
    copyFileSync(backup, path.join(WEB_DIR, name));
    if (deleteBackups) {
      rmSync(backup, { force: true });
    }
  }
}

// A run that was killed abnormally can leave its dev server behind, and Next
// refuses to start a second one in the same output folder. The process group
// ID is saved so the next run can stop the old one.
function stopStaleServer(): void {
  if (!existsSync(PID_FILE)) {
    return;
  }
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  rmSync(PID_FILE, { force: true });
  // Gives the old server a moment to release its port and lock file.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
}

export async function startDevServer(options: {
  linearApiUrl: string;
}): Promise<DevServer> {
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;

  mkdirSync(WORK_DIR, { recursive: true });
  stopStaleServer();
  // Backups still here mean the last run died before it restored the files.
  // They hold the originals, so put them back before taking new backups.
  restoreFiles(true);
  // `next dev` rewrites these files to suit its own output folder. Restoring
  // them keeps `npm run typecheck` working and the git tree clean afterwards.
  for (const name of REWRITTEN_BY_NEXT) {
    const file = path.join(WEB_DIR, name);
    if (existsSync(file)) {
      copyFileSync(file, path.join(WORK_DIR, `${name}.bak`));
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of BLANKED_ENV) {
    env[key] = "";
  }
  Object.assign(env, {
    NODE_ENV: "development",
    NEXT_DIST_DIR: path.relative(WEB_DIR, path.join(WORK_DIR, "next")),
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: databaseUrl(),
    AUTH_SECRET,
    AUTH_GOOGLE_ID: "stub",
    AUTH_GOOGLE_SECRET: "stub",
    BETTER_AUTH_URL: baseUrl,
    NEXT_PUBLIC_DOCS_BASE_URL: "https://datahub.arcadiascience.com",
    LOCAL_S3_MIRROR: MIRROR_DIR,
    S3_RAW_DATA_BUCKET: "test-raw-data-bucket",
    AWS_ACCESS_KEY_ID: "docs-screenshots",
    AWS_SECRET_ACCESS_KEY: "docs-screenshots",
    AWS_REGION: "us-east-1",
    INTEGRATION_SECRETS_KEY,
    __TEST_LINEAR_API_URL: options.linearApiUrl,
    TZ: TIME_ZONE,
  });

  const child: ChildProcess = spawn(
    process.execPath,
    [NEXT_BIN, "dev", "--turbopack", "-p", String(port)],
    // A new process group lets `stop` end Next's own child processes too.
    { cwd: WEB_DIR, env, stdio: "pipe", detached: true }
  );
  if (child.pid) {
    writeFileSync(PID_FILE, String(child.pid));
  }
  let recentOutput = "";
  const remember = (data: Buffer) => {
    recentOutput = (recentOutput + data.toString()).slice(-4000);
  };
  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);

  // Synchronous so it can also run from the `exit` event, which is the only
  // hook left after Ctrl-C. Skipping it would leave the dev server running.
  let stopped = false;
  const stopNow = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    rmSync(PID_FILE, { force: true });
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    restoreFiles(false);
  };
  // Nothing can wait after `exit`, so this restores for good.
  process.once("exit", () => {
    stopNow();
    restoreFiles(true);
  });
  const stop = async () => {
    stopNow();
    // Next may touch the files once more as it shuts down.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    restoreFiles(true);
  };

  try {
    await waitForServer(baseUrl);
  } catch (err) {
    await stop();
    throw new Error(`${(err as Error).message}\n${recentOutput}`);
  }
  return { baseUrl, stop };
}

// Better Auth reads this cookie, signed with the server's secret. Writing the
// session row directly avoids the dev-only sign-in form, so the run doesn't
// depend on it.
export async function createSessionCookie(
  db: NodePgDatabase<Record<string, unknown>>,
  userId: string
): Promise<{ name: string; value: string }> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    token,
    userId,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  });
  const signature = await makeSignature(token, AUTH_SECRET);
  return {
    name: SESSION_COOKIE_NAME,
    value: encodeURIComponent(`${token}.${signature}`),
  };
}
