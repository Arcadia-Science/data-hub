import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import net from "node:net";
import postgres from "postgres";

const TEST_DB = "data_hub_test";
// Matches the credentials expected by the CI Postgres service container
// and local dev defaults. Override via env vars if using a non-standard setup.
const PG_URL = `postgres://postgres:postgres@127.0.0.1:5432`;

let serverProcess: ChildProcess | null = null;

// Bind to port 0, let the OS assign a free port, then immediately release it.
// This avoids hardcoding a port that might collide with other services.
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("Failed to get free port"));
      }
    });
    srv.on("error", reject);
  });
}

// Poll until the server responds with a non-5xx status. A 404 or redirect
// from the root URL is fine — it just means the app is up and routing works.
async function waitForServer(url: string, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Server at ${url} did not become ready within ${timeoutMs}ms`
  );
}

export async function setup() {
  // 1. Connect to the default `postgres` DB to create the test database.
  //    We can't use the test DB URL directly because it might not exist yet.
  const adminSql = postgres(`${PG_URL}/postgres`);
  const existing = await adminSql`
    SELECT 1 FROM pg_database WHERE datname = ${TEST_DB}
  `;
  if (existing.length === 0) {
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB}`);
  }
  await adminSql.end();

  const databaseUrl = `${PG_URL}/${TEST_DB}`;

  // 2. Push schema via drizzle-kit. --force skips the interactive confirmation
  //    prompt that drizzle-kit shows when it detects destructive changes.
  execSync("npx drizzle-kit push --force", {
    cwd: import.meta.dirname ? import.meta.dirname + "/../.." : process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  // 3. Build and start the Next.js production server. We use a production
  //    build (`next build` + `next start`) rather than `next dev` because:
  //    - dev mode re-compiles on every request, making tests 5-10x slower
  //    - production mode matches the actual deployment behavior
  //
  //    AUTH_SECRET is required by NextAuth even though we bypass sessions in
  //    tests (PAT auth). AUTH_GOOGLE_* stubs prevent startup errors from the
  //    Google OAuth provider config.
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
    AUTH_GOOGLE_ID: "stub",
    AUTH_GOOGLE_SECRET: "stub",
    // Dummy AWS credentials so the S3 presigner can compute signatures
    // without hitting the real credential provider chain. getSignedUrl only
    // needs a key pair for HMAC signing — it never makes a network call.
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test-key",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret",
    AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
    S3_RAW_DATA_BUCKET:
      process.env.S3_RAW_DATA_BUCKET ?? "test-raw-data-bucket",
  };
  // Strip Lambda config so "not configured" test cases work regardless of
  // the developer's local .env. Tests that need Lambda stubbed should mock
  // the fetch call instead of relying on ambient env.
  delete serverEnv.LAMBDA_FUNCTION_URL;
  delete serverEnv.LAMBDA_INVOKE_TOKEN;

  execSync("npx next build", {
    cwd: import.meta.dirname ? import.meta.dirname + "/../.." : process.cwd(),
    env: serverEnv,
    stdio: "pipe",
  });

  serverProcess = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: import.meta.dirname ? import.meta.dirname + "/../.." : process.cwd(),
    env: serverEnv,
    stdio: "pipe",
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.includes("Error") || msg.includes("error")) {
      console.error("[next start stderr]", msg);
    }
  });

  await waitForServer(baseUrl);

  // Vitest global setup runs in a separate worker from tests. The only way
  // to pass dynamic values (port, DB URL) to test files is via process.env,
  // which Vitest propagates to test workers automatically.
  process.env.__TEST_BASE_URL = baseUrl;
  process.env.__TEST_DATABASE_URL = databaseUrl;

  return async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      serverProcess = null;
    }
  };
}
