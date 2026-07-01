// Clear run and file records from a Data Hub database while preserving
// instruments and watchers, so lab instrument PCs can be re-pointed between
// environments without losing their identity/registration.
//
// This is the tool used to reset the long-lived "staging-as-prod" database
// before real production cutover. It does NOT touch S3 — object deletion is a
// separate, manual step.
//
// Unlike scripts/reset-database.ts and scripts/seed-database.ts, this script
// intentionally targets a REMOTE database, so it deliberately does NOT use
// assertLocalDatabaseUrl. Guardrails instead: dry-run by default, an explicit
// --confirm flag to mutate, and it echoes the (redacted) target host.
//
// Usage:
//   DATABASE_URL=postgres://…  tsx scripts/clear-run-file-records.ts            # dry run: counts only
//   DATABASE_URL=postgres://…  tsx scripts/clear-run-file-records.ts --confirm  # actually delete
//   …--confirm --clear-watcher-activity   # also drop watcher heartbeats/events

import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const args = new Set(process.argv.slice(2));
const confirm = args.has("--confirm");
const clearWatcherActivity = args.has("--clear-watcher-activity");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("clear-run-file-records: DATABASE_URL is not set.");
  process.exit(1);
}

// Local dev has its own reset/reseed tooling; this destructive-on-remote
// script should never be the thing pointed at the dev DB by mistake.
const LOCAL_DATABASE_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/data-hub-local";
if (databaseUrl === LOCAL_DATABASE_URL) {
  console.error(
    "clear-run-file-records: DATABASE_URL points at the local dev database."
  );
  console.error("  Use `npm run db:reseed` for local resets instead.");
  process.exit(1);
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

// Mirror lib/db/index.ts: managed Postgres (Render) needs TLS over the public
// endpoint; only 127.0.0.1/localhost speak plaintext.
function requiresSsl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}

// Child-first: everything that FK-references instrument_runs (and, for
// `files`, has onDelete: no action) must go before the runs themselves.
const RUN_FILE_TABLES = [
  "notifications",
  "run_comments",
  "run_attributions",
  "archive_jobs",
  "files",
  "instrument_runs",
] as const;

const WATCHER_ACTIVITY_TABLES = [
  "watcher_events",
  "watcher_heartbeats",
] as const;

const tablesToClear = clearWatcherActivity
  ? [...WATCHER_ACTIVITY_TABLES, ...RUN_FILE_TABLES]
  : RUN_FILE_TABLES;

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: requiresSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
});
const db = drizzle(pool);

console.log(`Target database: ${redact(databaseUrl)}`);
console.log(
  `Mode: ${confirm ? "DELETE (irreversible)" : "dry run (no changes)"}`
);
console.log("");

async function countRows(table: string): Promise<number> {
  const result = await db.execute<{ count: number }>(
    sql.raw(`SELECT count(*)::int AS count FROM "${table}"`)
  );
  return Number(result.rows[0]?.count ?? 0);
}

try {
  console.log("Row counts:");
  for (const table of tablesToClear) {
    console.log(`  ${table}: ${await countRows(table)}`);
  }

  console.log("");
  console.log("Preserved (not touched):");
  for (const table of ["instruments", "watchers"]) {
    console.log(`  ${table}: ${await countRows(table)}`);
  }
  console.log("");

  if (confirm) {
    await db.transaction(async (tx) => {
      for (const table of tablesToClear) {
        const result = await tx.execute(sql.raw(`DELETE FROM "${table}"`));
        console.log(`Deleted ${result.rowCount ?? 0} rows from ${table}.`);
      }
    });

    console.log("");
    console.log("Done. Instruments and watchers were preserved.");
    console.log("Reminder: S3 objects were NOT deleted — do that separately.");
  } else {
    console.log("Dry run only. Re-run with --confirm to delete the above.");
  }
} finally {
  await pool.end();
}
