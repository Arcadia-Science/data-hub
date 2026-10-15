// Seed the local development database with a believable steady state:
// Alice Zimmerman (admin) + teammates, the production instrument catalog
// plus one pending instrument, watchers with heartbeats / events, runs
// with realistic filenames, comments, attributions, and archive jobs.
//
// Usage:
//   npm run db:seed           # seed on top of whatever's there
//   npm run db:reseed         # reset → push → seed (the usual loop)
//
// Opens its own `pg` pool (instead of importing `@/lib/db`) so the pool
// closes cleanly at the end of the script — the app-side singleton in
// `lib/db/index.ts` is wired for long-lived Next.js processes and never
// calls `.end()`.

// biome-ignore lint/performance/noNamespaceImport: drizzle scripts need the full schema module for Db typing
import * as schema from "@/lib/db/schema";
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { assertLocalDatabaseUrl } from "./assert-local-db";
import { processSeededFixtures } from "./process-fixtures";
import { seedWorkspace } from "./seed-workspace";

const databaseUrl = assertLocalDatabaseUrl("db:seed");

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool, { schema });

const { admin } = await seedWorkspace(db);

// Drive the lambda handler over each fixture-bearing run so the
// dashboard shows real processed artifacts (gel-doc PNGs, plate-
// reader CSVs, qPCR metadata) immediately after a reseed. Skips
// quietly with an actionable hint when the dev API isn't running
// yet — see web/scripts/process-fixtures.ts for the gating logic.
await processSeededFixtures(db, { apiKey: admin.token });

await pool.end();

console.log("");
console.log("Done. Sign in at http://localhost:3000/login with:");
console.log(`  email: ${admin.email}`);
console.log("");
console.log("Or call the API with the seeded PAT:");
console.log(`  curl -H 'Authorization: Bearer ${admin.token}' \\`);
console.log("    http://localhost:3000/api/v1/instruments");
