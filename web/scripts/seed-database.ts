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
import {
  clearAll,
  SEED_ADMIN_EMAIL,
  SEED_ADMIN_NAME,
  SEED_WATCHER_VERSION,
  type SeededRun,
  seedArchiveJobs,
  seedDevUser,
  seedInstrumentSubscriptions,
  seedInstruments,
  seedNotifications,
  seedRunAttributions,
  seedRunComments,
  seedRuns,
  seedSlackChannelConfig,
  seedTeammates,
  seedWatcherReleaseConfig,
  seedWatchers,
} from "@/lib/db/seed";
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { assertLocalDatabaseUrl } from "./assert-local-db";
import { processSeededFixtures } from "./process-fixtures";

const databaseUrl = assertLocalDatabaseUrl("db:seed");

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool, { schema });

console.log("Clearing existing rows…");
await clearAll(db);

console.log("Seeding watcher_release_config…");
await seedWatcherReleaseConfig(db, {
  latestVersion: SEED_WATCHER_VERSION,
  minSupportedVersion: "0.1.0",
});

console.log("Seeding slack_channel_config…");
await seedSlackChannelConfig(db);

console.log("Seeding admin user…");
const { userId, email, token } = await seedDevUser(db, {
  email: SEED_ADMIN_EMAIL,
  name: SEED_ADMIN_NAME,
  isAdmin: true,
});

console.log("Seeding instruments…");
const instruments = await seedInstruments(db);

console.log("Seeding watchers + heartbeats + events…");
await seedWatchers(db, instruments);

console.log("Seeding runs + files…");
const activeInstruments = instruments.filter((i) => i.status === "active");
const runs: SeededRun[] = [];
for (const instrument of activeInstruments) {
  runs.push(...(await seedRuns(db, instrument.id, 8)));
}

console.log("Seeding teammate users…");
const teammates = await seedTeammates(db);

console.log("Seeding run comments + attributions…");
const commentAuthors = [
  { id: userId, name: SEED_ADMIN_NAME },
  ...teammates.map((t) => ({ id: t.id, name: t.name })),
];
await seedRunComments(db, runs, commentAuthors);
const attributionUserIds = [userId, ...teammates.slice(0, 8).map((t) => t.id)];
await seedRunAttributions(db, runs, attributionUserIds);

console.log("Seeding archive_jobs…");
await seedArchiveJobs(db, runs, userId);

console.log("Seeding instrument subscriptions for the admin…");
await seedInstrumentSubscriptions(
  db,
  userId,
  activeInstruments.map((i) => i.id)
);

console.log("Seeding notifications (run_created + comment rows)…");
const notifResult = await seedNotifications(db, {
  recipientUserId: userId,
  runs,
  teammates,
});
console.log(
  `  ${notifResult.total} notifications inserted (${notifResult.unread} unread).`
);

// Drive the lambda handler over each fixture-bearing run so the
// dashboard shows real processed artifacts (gel-doc PNGs, plate-
// reader CSVs, qPCR metadata) immediately after a reseed. Skips
// quietly with an actionable hint when the dev API isn't running
// yet — see web/scripts/process-fixtures.ts for the gating logic.
await processSeededFixtures(db, { apiKey: token });

await pool.end();

console.log("");
console.log("Done. Sign in at http://localhost:3000/login with:");
console.log(`  email: ${email}`);
console.log("");
console.log("Or call the API with the seeded PAT:");
console.log(`  curl -H 'Authorization: Bearer ${token}' \\`);
console.log("    http://localhost:3000/api/v1/instruments");
