// Retakes the docs screenshots from a throwaway local database.
//
//   npm run docs:screenshots                      # every screenshot
//   npm run docs:screenshots -- --only home,my-runs
//   npm run docs:screenshots -- --skip-seed       # reuse the last run's data
//   npm run docs:screenshots -- --serve           # seed and start the app, then wait
//
// See docs/developer/local-development.md for what it needs.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { asc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
// biome-ignore lint/performance/noNamespaceImport: drizzle scripts need the full schema module for Db typing
import * as schema from "@/lib/db/schema";
import { SEED_ADMIN_EMAIL } from "@/lib/db/seed";
import { processSeededFixtures } from "../process-fixtures";
import { seedWorkspace } from "../seed-workspace";
import { captureShot, launchBrowser } from "./capture";
import {
  type DevServer,
  databaseUrl,
  MIRROR_DIR,
  resetDatabase,
  resetMirror,
  startDevServer,
  WORK_DIR,
} from "./environment";
import {
  displayAddress,
  type ResolvedShot,
  type RunReport,
  writeImage,
  writeManifest,
  writeSummary,
} from "./output";
import {
  addSampleTokens,
  createWorld,
  keepWatchersOnline,
  startFakeLinear,
  type World,
} from "./setup";
import { MANUAL_SHOTS, SHOTS } from "./shots";
import { THEMES } from "./types";

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    "skip-seed": { type: "boolean", default: false },
    serve: { type: "boolean", default: false },
  },
});

function selectShots() {
  if (!args.only) {
    return SHOTS;
  }
  const wanted = new Set(args.only.split(",").map((name) => name.trim()));
  const unknown = [...wanted].filter(
    (name) => !SHOTS.some((shot) => shot.name === name)
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown screenshot: ${unknown.join(", ")}. Names are listed in shots.ts.`
    );
  }
  return SHOTS.filter((shot) => wanted.has(shot.name));
}

function hasCommand(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

// The first request to an API route makes the dev server compile it, and the
// fixture step gives each request only a couple of seconds.
async function warmUpApi(baseUrl: string, token: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/instruments?per_page=1`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(
      `The app's API answered ${res.status} to a warm-up request`
    );
  }
}

async function loadSeededWorkspace(pool: Pool) {
  const db = drizzle(pool, { schema });
  const [admin] = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.email, SEED_ADMIN_EMAIL))
    .limit(1);
  if (!admin) {
    throw new Error(
      "The screenshot database has no seeded data. Run without --skip-seed first."
    );
  }
  const teammates = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.users)
    .where(ne(schema.users.email, SEED_ADMIN_EMAIL))
    .orderBy(asc(schema.users.name));
  const runs = await db
    .select({
      id: schema.instrumentRuns.id,
      instrumentId: schema.instrumentRuns.instrumentId,
      runId: schema.instrumentRuns.runId,
    })
    .from(schema.instrumentRuns);
  return {
    admin: { userId: admin.id, email: admin.email, token: "" },
    runs,
    teammates,
  };
}

async function main(): Promise<number> {
  const shots = selectShots();
  mkdirSync(WORK_DIR, { recursive: true });
  rmSync(path.join(WORK_DIR, "failures"), { recursive: true, force: true });

  const seed = !args["skip-seed"];
  if (seed) {
    resetMirror();
    await resetDatabase();
  }
  // The seed and the fixture step read this when they copy and process files.
  process.env.LOCAL_S3_MIRROR = MIRROR_DIR;

  const pool = new Pool({ connectionString: databaseUrl() });
  const fakeLinear = await startFakeLinear();
  let server: DevServer | null = null;
  let world: World | null = null;

  try {
    const workspace = seed
      ? await seedWorkspace(drizzle(pool, { schema }))
      : await loadSeededWorkspace(pool);

    console.log("Starting the app…");
    server = await startDevServer({ linearApiUrl: fakeLinear.url });

    if (seed) {
      if (hasCommand("uv")) {
        await warmUpApi(server.baseUrl, workspace.admin.token);
        await processSeededFixtures(drizzle(pool, { schema }), {
          apiKey: workspace.admin.token,
          apiUrl: `${server.baseUrl}/api/v1`,
        });
      } else {
        console.warn(
          "uv is not installed, so sample files are not processed. Reports and plots will be missing."
        );
      }
    }

    world = createWorld({
      ...workspace,
      baseUrl: server.baseUrl,
      databaseUrl: databaseUrl(),
      linearApiUrl: fakeLinear.url,
    });
    if (seed) {
      await addSampleTokens(world);
    }

    if (args.serve) {
      const cookie = await world.cookieFor(world.admin.userId);
      writeFileSync(
        path.join(WORK_DIR, "serve.json"),
        JSON.stringify({ baseUrl: server.baseUrl, cookie }, null, 2)
      );
      console.log(`\nServing at ${server.baseUrl}. Press Ctrl-C to stop.`);
      await new Promise(() => {
        // Waits for a signal. The handlers below stop everything.
      });
    }

    return await takeScreenshots(world, shots);
  } finally {
    await world?.close();
    await server?.stop();
    await fakeLinear.close();
    await pool.end();
  }
}

async function takeScreenshots(
  world: World,
  shots: typeof SHOTS
): Promise<number> {
  const report: RunReport = {
    failures: [],
    manual: MANUAL_SHOTS,
    taken: [],
    warnings: [],
  };
  const browser = await launchBrowser();

  try {
    for (const shot of shots) {
      console.log(`\n${shot.name}`);
      try {
        await keepWatchersOnline(world);
        await shot.prepare?.(world);
        const images = new Map<(typeof THEMES)[number], Buffer>();
        for (const theme of THEMES) {
          try {
            images.set(theme, await captureShot(browser, shot, theme, world));
          } catch (err) {
            throw new Error(
              `${theme}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        // Both themes or neither, so the docs never mix old and new images.
        for (const theme of THEMES) {
          const bytes = await writeImage(
            shot.name,
            theme,
            images.get(theme) as Buffer
          );
          console.log(`  ${theme}: ${Math.round(bytes / 1024)} KB`);
        }
        report.taken.push(shot.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  FAILED: ${message.split("\n")[0]}`);
        report.failures.push({ name: shot.name, error: message });
      } finally {
        // A cleanup that fails leaves changed data behind for later shots, so
        // it is reported, but it must not stop the run before the summary.
        try {
          await shot.cleanup?.(world);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  CLEANUP FAILED: ${message.split("\n")[0]}`);
          report.warnings.push({
            name: shot.name,
            error: `Cleanup failed, so later screenshots may show leftover data. ${message}`,
          });
        }
      }
    }
  } finally {
    await browser.close();
  }

  const resolved: ResolvedShot[] = [];
  for (const shot of SHOTS) {
    const route =
      typeof shot.path === "string" ? shot.path : await shot.path(world);
    resolved.push({
      shot,
      address: displayAddress(route, shot.address),
    });
  }
  writeManifest(resolved);

  console.log(`\n${writeSummary(report)}`);
  return report.failures.length > 0 ? 1 : 0;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // The `exit` handler in `environment.ts` stops the dev server.
    process.exit(130);
  });
}

process.exit(await main());
