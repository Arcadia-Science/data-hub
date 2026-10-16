// The seeded workspace: Alice Zimmerman (admin) and teammates, the instrument
// catalog, watchers, runs, comments, attributions, archive jobs, and
// notifications. Shared by `seed-database.ts` (local dev) and the docs
// screenshot run so both see the same data. Callers own the database safety
// check and the fixture-processing step, because both depend on how the
// caller reaches the app.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/lib/db/schema";
import {
  clearAll,
  SEED_ADMIN_EMAIL,
  SEED_ADMIN_NAME,
  SEED_WATCHER_VERSION,
  type SeededRun,
  type SeededTeammate,
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

type Db = NodePgDatabase<typeof schema>;

export interface SeededWorkspace {
  admin: { userId: string; email: string; token: string };
  runs: SeededRun[];
  teammates: SeededTeammate[];
}

export async function seedWorkspace(db: Db): Promise<SeededWorkspace> {
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
  const attributionUserIds = [
    userId,
    ...teammates.slice(0, 8).map((t) => t.id),
  ];
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

  return { admin: { userId, email, token }, runs, teammates };
}
