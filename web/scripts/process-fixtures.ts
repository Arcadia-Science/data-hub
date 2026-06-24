// Drives the lambda's `data-hub-process handler` CLI against the
// fixture-bearing rows the seed script created. Used by both the
// dev seed (`npm run db:seed`) and the standalone post-hoc script
// (`npm run db:process-fixtures`) so the two share probe / spawn
// logic verbatim.
//
// Lifecycle expectation:
//   1. The seed has already inserted instrument rows under their
//      canonical kebab ids and copied each fixture into the local
//      mirror at <LOCAL_S3_MIRROR>/test-raw-data-bucket/<...>.
//   2. The web app is running (`npm run dev`) so the lambda can
//      reach the dev API for the run/file upserts.
//
// If either precondition is missing this module short-circuits with
// a hint instead of failing the seed: spawning a transient Next dev
// server here would introduce port collisions, flaky readiness
// detection, and orphan-process risk for what is already a two-
// terminal workflow in practice.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
// biome-ignore lint/performance/noNamespaceImport: drizzle scripts need the full schema module for Db typing
import * as schema from "@/lib/db/schema";
import {
  CANONICAL_INSTRUMENT_ID,
  FIXTURES_DIR,
  INSTRUMENT_FIXTURES,
} from "@/lib/db/seed";

type Db = NodePgDatabase<typeof schema>;

// Resolve the lambda directory relative to *this* file (not
// `process.cwd()`) so `npm run db:seed` from `web/` and a manual
// `tsx web/scripts/...` from the repo root both work.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_DIR = path.resolve(SCRIPT_DIR, "..", "..", "lambda");

const DEFAULT_API_URL = "http://localhost:3000/api/v1";

export interface FixtureTriple {
  filename: string;
  instrumentId: string;
  runId: string;
}

export interface ProcessFixturesOptions {
  apiKey: string;
  apiUrl?: string;
  // When false, suppress the progress/skip logs (used by callers
  // that want to format their own output). Defaults to true.
  log?: boolean;
}

export interface ProcessFixturesResult {
  failed: number;
  // Counts of attempted handler invocations. `failed` rows are
  // logged but don't throw — the seed/processing step is best-
  // effort and never blocks the dev from getting back to work.
  ran: number;
  // Whether the entire step was skipped (mirror not configured, API
  // not reachable, or no fixture rows found). When skipped, no
  // handler invocation was attempted.
  skipped: boolean;
  // Reason for the skip — only set when `skipped` is true.
  skipReason?: "no-mirror" | "api-down" | "no-fixtures";
}

// Probe the dev API with the supplied PAT. Hits the auth-gated
// `/instruments` endpoint instead of an unauth health route so a
// successful 200 also confirms the PAT we're about to pass to the
// handler actually authenticates against this server.
async function probeApi(apiUrl: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/instruments?per_page=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Re-derive the (instrument_id, run_id, filename) triples that need
// processing from whatever the seed wrote into the DB. Runs DB-
// driven so the standalone script and the seed both use the same
// source of truth.
async function getFixtureTriples(db: Db): Promise<FixtureTriple[]> {
  const triples: FixtureTriple[] = [];
  for (const [instrumentType, fixture] of Object.entries(INSTRUMENT_FIXTURES)) {
    if (!fixture) {
      continue;
    }
    const canonicalId =
      CANONICAL_INSTRUMENT_ID[instrumentType as schema.InstrumentType];
    if (!canonicalId) {
      continue;
    }

    // Join `files` → `instrument_runs` to find every fixture-named
    // raw file under the canonical instrument. The seed only writes
    // one such row per run, but joining defends against a dev
    // having added more via `data-hub-process handler` directly.
    const rows = await db
      .select({ runId: schema.instrumentRuns.runId })
      .from(schema.files)
      .innerJoin(
        schema.instrumentRuns,
        eq(schema.files.instrumentRunId, schema.instrumentRuns.id)
      )
      .where(
        and(
          eq(schema.instrumentRuns.instrumentId, canonicalId),
          eq(schema.files.filename, fixture.filename),
          eq(schema.files.category, "raw")
        )
      );

    for (const row of rows) {
      triples.push({
        instrumentId: canonicalId,
        runId: row.runId,
        filename: fixture.filename,
      });
    }
  }
  return triples;
}

// Spawn `uv run data-hub-process handler …` for one triple. Inherits
// stdio so the dev sees the inner per-instrument processor's logs in
// real time — the alternative (capture + replay on failure) hides
// progress on the slow ones (gel-doc PNG export, plate-reader xls
// parse) which is exactly when the dev wants to see something.
async function runHandler(
  triple: FixtureTriple,
  opts: { apiUrl: string; apiKey: string; mirrorRoot: string | undefined }
): Promise<void> {
  const sourcePath = path.join(FIXTURES_DIR, triple.filename);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "uv",
      [
        "run",
        "data-hub-process",
        "handler",
        triple.instrumentId,
        triple.runId,
        triple.filename,
        "--source",
        sourcePath,
      ],
      {
        cwd: LAMBDA_DIR,
        env: {
          ...process.env,
          DATA_HUB_API_URL: opts.apiUrl,
          DATA_HUB_API_KEY: opts.apiKey,
          ...(opts.mirrorRoot ? { LOCAL_S3_MIRROR: opts.mirrorRoot } : {}),
        },
        stdio: "inherit",
      }
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`data-hub-process handler exited with code ${code}`))
    );
  });
}

// Print an actionable hint when we skip — devs running this for the
// first time shouldn't have to read the source to figure out why
// processed bytes aren't appearing in the dashboard.
function printSkipHint(
  reason: NonNullable<ProcessFixturesResult["skipReason"]>
) {
  const lines = ["", `[fixtures] Skipping fixture processing: ${reason}.`];
  if (reason === "no-mirror") {
    lines.push(
      "[fixtures] Set LOCAL_S3_MIRROR in web/.env (e.g. ../lambda/.local-s3) and reseed.",
      "[fixtures] See docs/local-development.md for the full workflow."
    );
  } else if (reason === "api-down") {
    lines.push(
      "[fixtures] The dev API is not reachable. After `npm run dev` is up, run:",
      "[fixtures]   npm run db:process-fixtures"
    );
  } else if (reason === "no-fixtures") {
    lines.push(
      "[fixtures] No fixture-bearing runs found in the database — has the seed run yet?"
    );
  }
  console.log(lines.join("\n"));
}

export async function processSeededFixtures(
  db: Db,
  opts: ProcessFixturesOptions
): Promise<ProcessFixturesResult> {
  const log = opts.log ?? true;
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const mirrorRoot = process.env.LOCAL_S3_MIRROR;

  // Skip 1: no mirror configured. Without it, the seed didn't copy
  // fixtures into a place the lambda can read, so processing has
  // nothing to act on.
  if (!mirrorRoot) {
    if (log) {
      printSkipHint("no-mirror");
    }
    return { skipped: true, skipReason: "no-mirror", ran: 0, failed: 0 };
  }

  // Skip 2: API unreachable. We probe with the same PAT we're about
  // to hand to the lambda, so a successful probe also confirms the
  // PAT works. A 2-second timeout is generous for localhost — Next
  // dev server first-byte is sub-100ms once it's up.
  const apiUp = await probeApi(apiUrl, opts.apiKey);
  if (!apiUp) {
    if (log) {
      printSkipHint("api-down");
    }
    return { skipped: true, skipReason: "api-down", ran: 0, failed: 0 };
  }

  // Skip 3: nothing to do. Likely means the DB hasn't been seeded
  // yet, or the canonical instrument ids drifted from this script.
  const triples = await getFixtureTriples(db);
  if (triples.length === 0) {
    if (log) {
      printSkipHint("no-fixtures");
    }
    return { skipped: true, skipReason: "no-fixtures", ran: 0, failed: 0 };
  }

  if (log) {
    console.log("");
    console.log(
      `[fixtures] Processing ${triples.length} fixture run${triples.length === 1 ? "" : "s"} via the lambda handler…`
    );
  }

  let ran = 0;
  let failed = 0;
  for (const triple of triples) {
    if (log) {
      console.log("");
      console.log(
        `[fixtures] ${triple.instrumentId} / ${triple.runId} / ${triple.filename}`
      );
    }
    try {
      await runHandler(triple, {
        apiUrl,
        apiKey: opts.apiKey,
        mirrorRoot,
      });
      ran += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[fixtures] Failed: ${triple.instrumentId}/${triple.runId} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (log) {
    console.log("");
    console.log(
      `[fixtures] Done. ${ran} processed${failed > 0 ? `, ${failed} failed` : ""}.`
    );
  }

  return { skipped: false, ran, failed };
}
