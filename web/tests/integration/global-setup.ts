import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { Client, Pool } from "pg";
import { CREATE_NATURAL_FILENAME_COLLATION } from "@/lib/db/collations";

const TEST_DB = "data_hub_test";
// Matches the credentials expected by the CI Postgres service container
// and local dev defaults. Override via env vars if using a non-standard setup.
const PG_URL = "postgres://postgres:postgres@127.0.0.1:5432";

let serverProcess: ChildProcess | null = null;
let slackCaptureServer: http.Server | null = null;

// Captured Slack DM calls (chat.postMessage). Separate from the webhook buffer
// so tests can assert each channel independently.
interface CapturedDm {
  blocks?: unknown[];
  channel: string;
  text: string;
}
const capturedDms: CapturedDm[] = [];

// Bind to port 0, let the OS assign a free port, then immediately release it.
// This avoids hardcoding a port that might collide with other services.
function getFreePort(): Promise<number> {
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
      if (res.ok || res.status < 500) {
        return;
      }
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
  const adminClient = new Client({ connectionString: `${PG_URL}/postgres` });
  await adminClient.connect();
  try {
    const existing = await adminClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [TEST_DB]
    );
    if (existing.rows.length === 0) {
      // CREATE DATABASE can't be parameterized; TEST_DB is a trusted constant.
      await adminClient.query(`CREATE DATABASE ${TEST_DB}`);
    }
  } finally {
    await adminClient.end();
  }

  const databaseUrl = `${PG_URL}/${TEST_DB}`;

  // Reset the public schema so `drizzle-kit push` always creates tables from
  // scratch. A persisted test DB with a prior Auth.js-shaped `user`/`account`
  // would otherwise force interactive column-rename prompts that `--force`
  // cannot answer in CI. Push also installs neither `pg_trgm` (needed by the
  // trigram GIN indexes) nor the `natural_filename` collation.
  const trgmClient = new Client({ connectionString: databaseUrl });
  await trgmClient.connect();
  try {
    await trgmClient.query("DROP SCHEMA public CASCADE");
    await trgmClient.query("CREATE SCHEMA public");
    await trgmClient.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await trgmClient.query(CREATE_NATURAL_FILENAME_COLLATION);
  } finally {
    await trgmClient.end();
  }

  // Stand up an in-process HTTP capture server so tests can assert on
  // outgoing Slack webhook calls and Slack Web API DMs without depending on
  // the real Slack API.
  //
  // The capture server handles:
  //   POST /webhook            — incoming webhook (slack_channel_config)
  //   GET  /captured           — read webhook capture buffer
  //   POST /clear              — reset webhook buffer
  //   POST /api/chat.postMessage — Web API DM capture (__TEST_SLACK_API_URL)
  //   GET  /dms/captured       — read DM capture buffer
  //   POST /dms/clear          — reset DM buffer
  //
  // Tests inspect captured payloads via helpers in helpers.ts.
  const captured: { text: string }[] = [];
  const slackPort = await getFreePort();
  slackCaptureServer = http.createServer((req, res) => {
    // --- Incoming webhook (existing) ---
    if (req.method === "POST" && req.url === "/webhook") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.text === "string") {
            captured.push({ text: parsed.text });
          }
        } catch {
          // ignore non-JSON bodies; never thrown by sendSlackMessage
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      return;
    }
    if (req.method === "GET" && req.url === "/captured") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(captured));
      return;
    }
    if (req.method === "POST" && req.url === "/clear") {
      captured.length = 0;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    // --- Slack Web API mock (chat.postMessage for DMs) ---
    // The @slack/web-api SDK sends chat.postMessage as
    // application/x-www-form-urlencoded with complex fields (e.g. `blocks`)
    // JSON-encoded as strings inside the form body.
    if (req.method === "POST" && req.url === "/api/chat.postMessage") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const params = new URLSearchParams(raw);
        const channel = params.get("channel") ?? "";

        // Tests inject Slack platform errors via a sentinel channel id of the
        // form `U_FAIL_<error_code>`. The WebClient surfaces `<error_code>` as
        // `err.data.error`, exercising the real failure-handling branches.
        if (channel.startsWith("U_FAIL_")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: channel.slice("U_FAIL_".length),
            })
          );
          return;
        }

        try {
          const text = params.get("text") ?? "";
          const blocksRaw = params.get("blocks");
          let blocks: unknown[] | undefined;
          if (blocksRaw) {
            try {
              blocks = JSON.parse(blocksRaw) as unknown[];
            } catch {
              // blocks not parseable — skip
            }
          }
          capturedDms.push({ channel, text, blocks });
        } catch {
          // ignore unparseable bodies
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ts: "1234567890.000001" }));
      });
      return;
    }

    if (req.method === "GET" && req.url === "/dms/captured") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(capturedDms));
      return;
    }
    if (req.method === "POST" && req.url === "/dms/clear") {
      capturedDms.length = 0;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) =>
    slackCaptureServer?.listen(slackPort, "127.0.0.1", resolve)
  );
  const slackCaptureBaseUrl = `http://127.0.0.1:${slackPort}`;

  // 2. Push schema via drizzle-kit. --force skips the interactive confirmation
  //    prompt that drizzle-kit shows when it detects destructive changes.
  execSync("npx drizzle-kit push --force", {
    cwd: import.meta.dirname ? `${import.meta.dirname}/../..` : process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  // 2a. Seed singleton config rows with stable defaults for integration
  //     tests. Individual tests assert against these values. Previously
  //     watcher release used WATCHER_* env vars and Slack channel used
  //     SLACK_WEBHOOK_URL; the source of truth is now the DB.
  const seedPool = new Pool({ connectionString: databaseUrl });
  try {
    await seedPool.query(`
      INSERT INTO watcher_release_config
        (id, latest_version, min_supported_version, mandatory)
      VALUES
        (true, '9.9.9', '0.1.0', false)
      ON CONFLICT (id) DO UPDATE SET
        latest_version = excluded.latest_version,
        min_supported_version = excluded.min_supported_version,
        mandatory = excluded.mandatory,
        updated_at = now()
    `);
    await seedPool.query(
      `
      INSERT INTO slack_channel_config (id, webhook_url)
      VALUES (true, $1)
      ON CONFLICT (id) DO UPDATE SET
        webhook_url = excluded.webhook_url,
        updated_at = now()
    `,
      [`${slackCaptureBaseUrl}/webhook`]
    );
  } finally {
    await seedPool.end();
  }

  // 3. Build and start the Next.js production server. We use a production
  //    build (`next build` + `next start`) rather than `next dev` because:
  //    - dev mode re-compiles on every request, making tests 5-10x slower
  //    - production mode matches the actual deployment behavior
  //
  //    AUTH_SECRET is required by Better Auth even though we bypass sessions
  //    in tests (PAT auth). AUTH_GOOGLE_* stubs prevent startup errors from
  //    the Google OAuth provider config. BETTER_AUTH_URL must match the
  //    ephemeral test server origin.
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const authSecret = "test-secret-at-least-32-characters-long!!";
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: authSecret,
    AUTH_GOOGLE_ID: "stub",
    AUTH_GOOGLE_SECRET: "stub",
    BETTER_AUTH_URL: baseUrl,
    // Dummy AWS credentials so the S3 presigner can compute signatures
    // without hitting the real credential provider chain. getSignedUrl only
    // needs a key pair for HMAC signing — it never makes a network call.
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test-key",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret",
    AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
    S3_RAW_DATA_BUCKET:
      process.env.S3_RAW_DATA_BUCKET ?? "test-raw-data-bucket",
    // Watcher release-info defaults are seeded into the
    // `watcher_release_config` table above; the env-var fallback is gone.
    // Slack channel webhook URL is seeded into `slack_channel_config`
    // above so tests can assert on captured payloads without hitting Slack.
    // Stub bot token so sendSlackDm's guard passes; the WebClient is
    // redirected to the capture server via __TEST_SLACK_API_URL.
    SLACK_BOT_TOKEN: "xoxb-test-bot-token",
    __TEST_SLACK_API_URL: `${slackCaptureBaseUrl}/api/`,
    // Shared secret the cron sweep route checks. Tests send the same value
    // as a Bearer token (see upload-queue-sweep.test.ts).
    CRON_SECRET: "test-cron-secret",
    // MCP HTTP suite authenticates with PATs. `next start` sets
    // NODE_ENV=production, but BETTER_AUTH_URL is loopback so the
    // self-hosted production hard-off does not apply.
    MCP_ALLOW_PAT_AUTH: "true",
  };
  // Strip the Lambda Function URL so "not configured" test cases work
  // regardless of the developer's local .env. Tests that need a stubbed
  // Lambda HTTP call should mock fetch rather than set this URL.
  serverEnv.LAMBDA_FUNCTION_URL = undefined;
  // Strip AWS_ROLE_ARN as well so the SigV4 path in `lib/lambda.ts`
  // doesn't try to assume a Vercel OIDC role inside tests. The test
  // server still gets static AWS_ACCESS_KEY_ID/SECRET via the dummy
  // values plumbed above, which is enough to satisfy
  // `hasInvokeCredentials()` for any test that wants to exercise the
  // archive-builder configured path without standing up a real Lambda.
  serverEnv.AWS_ROLE_ARN = undefined;

  execSync("npx next build", {
    cwd: import.meta.dirname ? `${import.meta.dirname}/../..` : process.cwd(),
    env: serverEnv,
    stdio: "pipe",
  });

  serverProcess = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: import.meta.dirname ? `${import.meta.dirname}/../..` : process.cwd(),
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
  process.env.__TEST_AUTH_SECRET = authSecret;
  process.env.__TEST_SLACK_CAPTURE_URL = slackCaptureBaseUrl;
  process.env.__TEST_SLACK_DM_CAPTURE_URL = slackCaptureBaseUrl;
  // Propagate the Slack stubs to the Vitest test-worker process so that
  // library-level calls to `notifyRunCreated`/`notifyComment` (which invoke
  // `sendSlackDm` directly in-process) also route through the capture server
  // rather than the real Slack API or no-op on a missing token.
  process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
  process.env.__TEST_SLACK_API_URL = `${slackCaptureBaseUrl}/api/`;
  // Point the `@/lib/db` singleton at the test DB so library helpers
  // imported directly into test files (e.g. `notifyRunCreated` from
  // `@/lib/api/notifications`) hit the same database as `getTestDb()`.
  // Without this they'd silently read the developer's local
  // `DATABASE_URL`, where the relations under test don't exist. The
  // spawned Next.js server already gets the test DB via `serverEnv`.
  process.env.DATABASE_URL = databaseUrl;

  return async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      serverProcess = null;
    }
    if (slackCaptureServer) {
      await new Promise<void>((resolve, reject) =>
        slackCaptureServer?.close((err) => (err ? reject(err) : resolve()))
      );
      slackCaptureServer = null;
    }
  };
}
