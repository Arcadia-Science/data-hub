import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import net from "node:net";
import postgres from "postgres";

const TEST_DB = "data_hub_test";
const PG_URL = `postgres://postgres:postgres@127.0.0.1:5432`;

let serverProcess: ChildProcess | null = null;

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
  // 1. Create test database if it doesn't exist
  const adminSql = postgres(`${PG_URL}/postgres`);
  const existing = await adminSql`
    SELECT 1 FROM pg_database WHERE datname = ${TEST_DB}
  `;
  if (existing.length === 0) {
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB}`);
  }
  await adminSql.end();

  const databaseUrl = `${PG_URL}/${TEST_DB}`;

  // 2. Push schema via drizzle-kit
  execSync("npx drizzle-kit push --force", {
    cwd: import.meta.dirname ? import.meta.dirname + "/../.." : process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  // 3. Start Next.js server on a random port
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  execSync("npx next build", {
    cwd: import.meta.dirname ? import.meta.dirname + "/../.." : process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
      AUTH_GOOGLE_ID: "stub",
      AUTH_GOOGLE_SECRET: "stub",
    },
    stdio: "pipe",
  });

  serverProcess = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: import.meta.dirname ? import.meta.dirname + "/../.." : process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
      AUTH_GOOGLE_ID: "stub",
      AUTH_GOOGLE_SECRET: "stub",
    },
    stdio: "pipe",
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.includes("Error") || msg.includes("error")) {
      console.error("[next start stderr]", msg);
    }
  });

  await waitForServer(baseUrl);

  // Export for test helpers via env
  process.env.__TEST_BASE_URL = baseUrl;
  process.env.__TEST_DATABASE_URL = databaseUrl;

  return async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      serverProcess = null;
    }
  };
}
