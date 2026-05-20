// Seed the local development database with a believable steady state:
// a workspace admin user + PAT, one instrument per type, watchers with
// heartbeats / events, runs with files, comments, attributions, and
// archive jobs in each lifecycle state.
//
// Usage:
//   npm run db:seed           # seed on top of whatever's there
//   npm run db:reseed         # reset → push → seed (the usual loop)
//
// Opens its own `postgres` client (instead of importing `@/lib/db`) so
// the pool closes cleanly at the end of the script — the app-side
// singleton in `lib/db/index.ts` is wired for long-lived Next.js
// processes and never calls `.end()`.

import * as schema from "@/lib/db/schema";
import {
  clearAll,
  seedArchiveJobs,
  seedDevUser,
  seedInstruments,
  seedRunAttributions,
  seedRunComments,
  seedRuns,
  seedWatcherReleaseConfig,
  seedWatchers,
} from "@/lib/db/seed";
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set. Add it to web/.env or export it before running this script."
  );
  process.exit(1);
}

const client = postgres(databaseUrl);
const db = drizzle(client, { schema });

console.log("Clearing existing rows…");
await clearAll(db);

console.log("Seeding watcher_release_config…");
await seedWatcherReleaseConfig(db);

console.log("Seeding dev user…");
const { userId, email, token } = await seedDevUser(db, {
  email: "dev@local",
  name: "Dev User",
  isAdmin: true,
});

console.log("Seeding instruments…");
const instruments = await seedInstruments(db);

console.log("Seeding watchers + heartbeats + events…");
await seedWatchers(
  db,
  instruments.filter((i) => i.status === "active").map((i) => i.id)
);

console.log("Seeding runs + files…");
const runs = (
  await Promise.all(
    instruments
      .filter((i) => i.status === "active")
      .map((i) => seedRuns(db, i.id, 5))
  )
).flat();

console.log("Seeding run comments + attributions…");
await seedRunComments(db, runs, userId);
await seedRunAttributions(db, runs, userId);

console.log("Seeding archive_jobs…");
await seedArchiveJobs(db, runs, userId);

await client.end();

console.log("");
console.log("Done. Sign in at http://localhost:3000/login with:");
console.log(`  email: ${email}`);
console.log("");
console.log("Or call the API with the seeded PAT:");
console.log(`  curl -H 'Authorization: Bearer ${token}' \\`);
console.log(`    http://localhost:3000/api/v1/instruments`);
