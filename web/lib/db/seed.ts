// Shared seed builders used by both the local dev seed script
// (`scripts/seed-database.ts` → `npm run db:seed`) and the integration test
// helpers (`tests/integration/helpers.ts`). Centralizing them in `lib/`
// keeps the token-generation logic, instrument-type coverage, and TRUNCATE
// list in sync between the two consumers — adding a new table to the
// schema only requires updating this file.
//
// The functions are intentionally minimal and deterministic: no Faker, no
// randomness beyond UUIDs / token bytes. Bug reports against a seeded
// database should be reproducible from the same seed call sequence.

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName, isTable, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateToken, getTokenPrefix, hashToken } from "@/lib/tokens";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

// Bucket name shared with the lambda CLI's `data-hub-process handler`
// (`--raw-bucket` default). Exporting the constant means the seed and
// the CLI never drift — both the row's `s3_bucket` field and the
// directory under `LOCAL_S3_MIRROR` use the same string.
export const RAW_BUCKET = "test-raw-data-bucket";
export const ARCHIVES_BUCKET = "test-archives-bucket";

// ---------------------------------------------------------------------------
// clearAll — schema-driven TRUNCATE of every `pgTable` declared in
// `lib/db/schema.ts`. Uses CASCADE so FK ordering doesn't matter; the
// previous static `TRUNCATE_ORDER` list was a maintenance hazard (every
// new table required a manual edit) and is replaced by this.
// ---------------------------------------------------------------------------

export async function clearAll(db: Db): Promise<void> {
  // Cast through `unknown[]` so the `isTable` type predicate can narrow
  // away the `PgEnum`s and other non-table exports in the schema module
  // without TS complaining about cross-module generic identity on the
  // `PgTable<…>` types (which all structurally extend drizzle's `Table`
  // but TS won't accept the union as-is).
  const tableNames = (Object.values(schema) as unknown[])
    .filter(isTable)
    .map((t) => getTableName(t));

  if (tableNames.length === 0) {
    return;
  }

  // Quote each identifier so camelCase Drizzle-generated names (e.g.
  // `"user"` — a reserved word in some SQL dialects) round-trip safely.
  // `TRUNCATE ... RESTART IDENTITY CASCADE` resets sequences too so seed
  // ids start at 1 on every reseed, which keeps screenshot/bug-report
  // identifiers stable across reruns.
  const quoted = tableNames.map((n) => `"${n}"`).join(", ");
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`)
  );
}

// ---------------------------------------------------------------------------
// User + PAT
// ---------------------------------------------------------------------------

export interface SeedUserOptions {
  email?: string;
  // Optional PAT expiry. NULL (the default) means no expiry.
  expiresAt?: Date | null;
  isAdmin?: boolean;
  name?: string;
  // Permission scopes for the minted PAT. Defaults to `["*"]` so the
  // returned token can hit every v1 route — matches the historical test
  // behavior. Pass an explicit list to exercise scope enforcement.
  scopes?: string[];
}

export interface SeedUserResult {
  email: string;
  token: string;
  userId: string;
}

export async function seedDevUser(
  db: Db,
  options: SeedUserOptions = {}
): Promise<SeedUserResult> {
  const userId = crypto.randomUUID();
  const email = options.email ?? `test-${userId.slice(0, 8)}@example.com`;

  await db.insert(schema.users).values({
    id: userId,
    name: options.name ?? "Test User",
    email,
    isAdmin: options.isAdmin ?? false,
  });

  const plaintext = generateToken();
  await db.insert(schema.personalAccessTokens).values({
    userId,
    name: "seeded-token",
    tokenHash: hashToken(plaintext),
    tokenPrefix: getTokenPrefix(plaintext),
    scopes: options.scopes ?? ["*"],
    expiresAt: options.expiresAt === undefined ? null : options.expiresAt,
  });

  return { userId, email, token: plaintext };
}

// ---------------------------------------------------------------------------
// Watcher release config — singleton row consulted by the
// `/api/v1/watchers/:id/update-check` endpoint. Tests and the dev seed both
// want a stable baseline so the endpoint returns deterministic values.
// ---------------------------------------------------------------------------

export async function seedWatcherReleaseConfig(db: Db): Promise<void> {
  await db.execute(
    sql`INSERT INTO watcher_release_config
       (id, latest_version, min_supported_version, channel, mandatory)
     VALUES
       (true, '9.9.9', '0.1.0', 'stable', false)
     ON CONFLICT (id) DO UPDATE SET
       latest_version = EXCLUDED.latest_version,
       min_supported_version = EXCLUDED.min_supported_version,
       channel = EXCLUDED.channel,
       mandatory = EXCLUDED.mandatory,
       updated_at = now(),
       updated_by = NULL`
  );
}

// ---------------------------------------------------------------------------
// Instruments — one row per value in `instrumentTypeEnum.enumValues` so the
// dashboard exercises every instrument-type-specific UI variant. One
// instrument is seeded as `pending` so the activation flow shows up.
// ---------------------------------------------------------------------------

export interface SeededInstrument {
  displayName: string;
  id: string;
  instrumentType: schema.InstrumentType;
  status: "pending" | "active" | "inactive";
}

const INSTRUMENT_LABELS: Record<schema.InstrumentType, string> = {
  generic: "Generic Lab Instrument",
  plate_reader: "SpectraMax iD3 Plate Reader",
  gel_doc: "Azure 600 Gel Doc",
  qpcr: "Azure Cielo qPCR",
  tape_station: "Agilent TapeStation",
  hina_microscope: "Hina Microscope",
  epson_v700_scanner: "Epson V700 Scanner",
  instant_raman: "Instant Raman Spectrometer",
};

// Instrument types that map to a canonical kebab-case id baked into the
// lambda's `Instrument` enum and hardcoded inside each `process_file`.
// Using the canonical id here means seeded files live at the same
// `<bucket>/<instrument-id>/<run-id>/<filename>` path the lambda
// `process_file` modules read from, so a dev can run
// `data-hub-process handler` against a seeded run with no path
// rewriting. Other instrument types fall back to the cosmetic
// `seed-<type>` id since they don't have a canonical pipeline yet.
//
// Exported so `web/scripts/process-fixtures.ts` can map seeded rows
// back to the same canonical ids when invoking the handler.
export const CANONICAL_INSTRUMENT_ID: Partial<
  Record<schema.InstrumentType, string>
> = {
  qpcr: "azure-cielo-qpcr",
  gel_doc: "azure-600-gel-doc",
  plate_reader: "spectramax-id3-plate-reader",
};

export async function seedInstruments(db: Db): Promise<SeededInstrument[]> {
  const rows: SeededInstrument[] = schema.VALID_INSTRUMENT_TYPES.map(
    (type, idx) => ({
      id: CANONICAL_INSTRUMENT_ID[type] ?? `seed-${type.replace(/_/g, "-")}`,
      displayName: INSTRUMENT_LABELS[type],
      instrumentType: type,
      // First row pending so the "activate instrument" admin flow is
      // exercised; everything else active.
      status: idx === 0 ? ("pending" as const) : ("active" as const),
    })
  );

  await db.insert(schema.instruments).values(rows);
  return rows;
}

// ---------------------------------------------------------------------------
// Watchers + heartbeats + events
// ---------------------------------------------------------------------------

export interface SeededWatcher {
  id: string;
  instrumentId: string;
  status: "registered" | "watching" | "stopped";
}

const WATCHER_STATUSES = ["watching", "registered", "stopped"] as const;

export async function seedWatchers(
  db: Db,
  instrumentIds: string[]
): Promise<SeededWatcher[]> {
  if (instrumentIds.length === 0) {
    return [];
  }

  const now = new Date();
  const watcherValues = instrumentIds.map((instrumentId, idx) => {
    const status = WATCHER_STATUSES[idx % WATCHER_STATUSES.length];
    return {
      id: crypto.randomUUID(),
      instrumentId,
      hostname: `seed-host-${idx + 1}`,
      osInfo: "Windows 11 23H2",
      watcherVersion: "9.9.9",
      configChecksum: `seed-checksum-${idx + 1}`,
      configYaml: "# seeded watcher config\n",
      lastHeartbeatAt: status === "watching" ? now : null,
      status,
    };
  });

  const inserted = await db
    .insert(schema.watchers)
    .values(watcherValues)
    .returning({
      id: schema.watchers.id,
      instrumentId: schema.watchers.instrumentId,
      status: schema.watchers.status,
    });

  const watchingIds = inserted
    .filter((w) => w.status === "watching")
    .map((w) => w.id);

  if (watchingIds.length > 0) {
    // 10 heartbeats spread over the last hour for each watching watcher.
    const heartbeatRows = watchingIds.flatMap((watcherId) =>
      Array.from({ length: 10 }, (_, i) => ({
        watcherId,
        timestamp: new Date(now.getTime() - i * 5 * 60_000),
        status: "watching",
        uploadMode: "auto" as const,
        filesUploadedSinceLast: i === 0 ? 0 : 1,
        runsReportedSinceLast: 0,
        errorsSinceLast: 0,
        uptimeSeconds: 3600 - i * 300,
      }))
    );
    await db.insert(schema.watcherHeartbeats).values(heartbeatRows);

    const eventRows = watchingIds.flatMap((watcherId) => [
      {
        watcherId,
        eventType: "watcher_started" as const,
        message: "Watcher started",
        details: {},
        timestamp: new Date(now.getTime() - 60 * 60_000),
      },
      {
        watcherId,
        eventType: "config_synced" as const,
        message: "Config synced from server",
        details: {},
        timestamp: new Date(now.getTime() - 50 * 60_000),
      },
      {
        watcherId,
        eventType: "file_uploaded" as const,
        message: "Uploaded data_001.csv to S3",
        details: { filename: "data_001.csv" },
        timestamp: new Date(now.getTime() - 10 * 60_000),
      },
    ]);
    await db.insert(schema.watcherEvents).values(eventRows);
  }

  return inserted;
}

// ---------------------------------------------------------------------------
// Runs + files — keys live under `RAW_BUCKET` so the lambda CLI's
// `--raw-bucket` default and any `LOCAL_S3_MIRROR` directory layout
// match. When `LOCAL_S3_MIRROR` is set in dev, `seedRuns` also copies
// the fixture from `lambda/tests/fixtures/` for instruments listed in
// `INSTRUMENT_FIXTURES` so seeded runs render real bytes in the
// dashboard out of the box. Other instruments still 404 — devs use
// `data-hub-process handler` to stage real files for those.
// ---------------------------------------------------------------------------

export interface SeededRun {
  id: string;
  instrumentId: string;
  runId: string;
}

const FILE_STATUSES = ["uploaded", "completed", "failed"] as const;

export interface InstrumentFixture {
  contentType: string;
  filename: string;
  runIds: readonly string[];
}

// Maps each instrument-type that has a fixture file checked into the
// repo to its fixture filename, content-type, and a stable list of
// run ids that look like real ones from that instrument (the qPCR
// `process_file` documents `Experiment_YYYYMMDD`; the gel-doc and
// plate-reader modules treat the filename stem as the run id, so
// these mirror those formats). The run-id list length sets how many
// runs `seedRuns` produces for fixture-bearing instruments; other
// instruments keep the count argument and use synthetic
// `seed-run-N` ids. Adding a new entry here is enough to make every
// seeded run for that instrument type render real bytes (provided
// `LOCAL_S3_MIRROR` is set).
//
// Exported so `web/scripts/process-fixtures.ts` can re-derive the
// triples `(canonical_instrument_id, run_id, filename)` that need
// to be processed without re-running the seed.
export const INSTRUMENT_FIXTURES: Partial<
  Record<schema.InstrumentType, InstrumentFixture>
> = {
  qpcr: {
    filename: "azure_cielo_qpcr_example.csv",
    contentType: "text/csv",
    runIds: [
      "Experiment_20260129",
      "Experiment_20260122",
      "Experiment_20260115",
      "Experiment_20260108",
      "Experiment_20260101",
    ],
  },
  gel_doc: {
    filename: "azure_600_gel_doc_example.tif",
    contentType: "image/tiff",
    runIds: [
      "26.02.02_10.45.05",
      "26.01.26_15.10.30",
      "26.01.19_11.05.42",
      "26.01.12_14.22.18",
      "26.01.05_09.30.00",
    ],
  },
  plate_reader: {
    filename: "spectramax_plate_reader_endpoint.xls",
    contentType: "application/vnd.ms-excel",
    runIds: [
      "012926_AR_OD600",
      "012226_DK_OD750",
      "011526_AR_GFP_endpoint",
      "010826_DK_OD600",
      "010126_AR_OD750",
    ],
  },
};

// Resolve `lambda/tests/fixtures/` relative to this file so the path
// doesn't depend on `process.cwd()`. The seed entry-point and the
// integration test harness run from different working directories
// but both end up importing this module from the same on-disk path.
const SEED_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(
  SEED_DIR,
  "..",
  "..",
  "..",
  "lambda",
  "tests",
  "fixtures"
);

export async function seedRuns(
  db: Db,
  instrumentId: string,
  count = 5,
  instrumentType?: schema.InstrumentType
): Promise<SeededRun[]> {
  if (count <= 0) {
    return [];
  }

  const fixture = instrumentType
    ? INSTRUMENT_FIXTURES[instrumentType]
    : undefined;

  // Fixture-bearing instruments take their run-id strings from the
  // canonical-looking list (capped at `count` so the caller still
  // controls the run total). Other instruments keep the synthetic
  // `seed-run-N` ids — those rows aren't expected to round-trip
  // through any real `process_file`, so a generic identifier is
  // fine.
  const fixtureRunIds = fixture?.runIds.slice(0, count);

  // Spread runs across the last ~2 weeks (3, 6, 9, 12, 15 days back for
  // count = 5) so UI date filters like "last 7 days" / "last 14 days"
  // return non-empty, differing result sets.
  const now = new Date();
  const dayMs = 24 * 60 * 60_000;
  const runValues = Array.from({ length: count }, (_, i) => {
    const acquiredAt = new Date(now.getTime() - (i + 1) * 3 * dayMs);
    return {
      instrumentId,
      runId: fixtureRunIds?.[i] ?? `seed-run-${i + 1}`,
      source: (i % 2 === 0 ? "lambda" : "watcher") as "lambda" | "watcher",
      metadata: { seeded: true, sample_count: 96 - i },
      acquiredAt,
    };
  });

  const runs = await db
    .insert(schema.instrumentRuns)
    .values(runValues)
    .returning({
      id: schema.instrumentRuns.id,
      instrumentId: schema.instrumentRuns.instrumentId,
      runId: schema.instrumentRuns.runId,
    });

  // Fixture-bearing runs render exactly one file row — the real
  // fixture — so the UI doesn't show synthetic CSV siblings next to
  // a real `.tif` / `.xls`. Status still cycles across the 5 runs
  // (uploaded → completed → failed → uploaded → completed) for UI
  // mix. Other instruments keep the historical 3-files-per-run
  // shape (raw, raw, processed) with synthetic CSV names.
  const fileRows = fixture
    ? runs.map((run, runIdx) => {
        const status = FILE_STATUSES[runIdx % FILE_STATUSES.length];
        return {
          instrumentRunId: run.id,
          relativePath: fixture.filename,
          s3Bucket: RAW_BUCKET,
          s3Key: `${run.instrumentId}/${run.runId}/${fixture.filename}`,
          filename: fixture.filename,
          contentType: fixture.contentType,
          sizeBytes: 1024,
          category: "raw" as const,
          status,
          metadata: { seeded: true },
          errorMessage:
            status === "failed" ? "Seeded failure for UI exercise" : null,
          uploadedAt: status === "failed" ? null : new Date(),
          processedAt: status === "completed" ? new Date() : null,
        };
      })
    : runs.flatMap((run, runIdx) =>
        Array.from({ length: 3 }, (_, fi) => {
          const status = FILE_STATUSES[(runIdx + fi) % FILE_STATUSES.length];
          const category = fi === 2 ? ("processed" as const) : ("raw" as const);
          const filename = `${category}_${fi + 1}.csv`;
          return {
            instrumentRunId: run.id,
            relativePath: filename,
            s3Bucket: RAW_BUCKET,
            s3Key: `${run.instrumentId}/${run.runId}/${filename}`,
            filename,
            contentType: "text/csv",
            sizeBytes: 1024 * (fi + 1),
            category,
            status,
            metadata: { seeded: true },
            errorMessage:
              status === "failed" ? "Seeded failure for UI exercise" : null,
            uploadedAt: status === "failed" ? null : new Date(),
            processedAt: status === "completed" ? new Date() : null,
          };
        })
      );
  await db.insert(schema.files).values(fileRows);

  // If the local-mirror env var is set and this instrument type has
  // a fixture, copy the fixture bytes into
  // `<LOCAL_S3_MIRROR>/<RAW_BUCKET>/<instrumentId>/<runId>/<filename>`
  // for every run. The web app's local-mirror route then serves them
  // when the dashboard requests `/api/v1/files/<id>/download`.
  // Production-safety: `LOCAL_S3_MIRROR` is ignored in production by
  // `getLocalMirrorRoot` anyway, but seeding is also strictly a dev
  // workflow so this branch only fires locally regardless.
  const mirrorRoot = process.env.LOCAL_S3_MIRROR;
  if (mirrorRoot && fixture) {
    const src = path.resolve(FIXTURES_DIR, fixture.filename);
    await Promise.all(
      runs.map(async (run) => {
        const dest = path.resolve(
          mirrorRoot,
          RAW_BUCKET,
          run.instrumentId,
          run.runId,
          fixture.filename
        );
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(src, dest);
      })
    );
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Run comments + attributions
// ---------------------------------------------------------------------------

export async function seedRunComments(
  db: Db,
  runs: SeededRun[],
  userId: string
): Promise<void> {
  if (runs.length === 0) {
    return;
  }
  const rows = runs.map((run, i) => ({
    runId: run.id,
    userId,
    body: `Seeded comment ${i + 1} on **${run.runId}** — looks good!`,
  }));
  await db.insert(schema.runComments).values(rows);
}

export async function seedRunAttributions(
  db: Db,
  runs: SeededRun[],
  userId: string
): Promise<void> {
  if (runs.length === 0) {
    return;
  }
  const rows = runs.map((run) => ({ runId: run.id, userId }));
  await db.insert(schema.runAttributions).values(rows);
}

// ---------------------------------------------------------------------------
// Teammates — additional users (no PATs) that act as comment authors so the
// dev user receives `comment_attributed` / `comment_participated`
// notifications with realistic actor avatars + names. PATs are skipped on
// purpose: these accounts are populated for UI exercise, not for API
// scripting.
// ---------------------------------------------------------------------------

export interface SeededTeammate {
  email: string;
  id: string;
  name: string;
}

// Fixed preset list (rather than randomized) so reseeds produce stable
// identities — screenshots / bug reports referencing "Lucy" keep matching
// after a `db:reseed`.
const TEAMMATE_PRESETS: Array<Omit<SeededTeammate, "id">> = [
  { name: "Lucy Hurlbut", email: "lucy@local" },
  { name: "Marcus Chen", email: "marcus@local" },
  { name: "Priya Patel", email: "priya@local" },
];

export async function seedTeammates(
  db: Db,
  count = 2
): Promise<SeededTeammate[]> {
  const chosen = TEAMMATE_PRESETS.slice(0, Math.max(0, count));
  if (chosen.length === 0) {
    return [];
  }
  const rows = chosen.map((preset) => ({
    id: crypto.randomUUID(),
    name: preset.name,
    email: preset.email,
    isAdmin: false,
  }));
  await db.insert(schema.users).values(rows);
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email }));
}

// ---------------------------------------------------------------------------
// Per-(user, instrument) `run_created` subscriptions. Seeded so the
// /settings/notifications form renders with a believable mix of enabled +
// disabled toggles instead of every row defaulting to off.
// ---------------------------------------------------------------------------

export async function seedInstrumentSubscriptions(
  db: Db,
  userId: string,
  instrumentIds: string[],
  enabledCount?: number
): Promise<void> {
  if (instrumentIds.length === 0) {
    return;
  }
  // Default: roughly the first half of the list enabled, the rest left as
  // explicit `enabled = false` rows so the toggle is materialised in the
  // settings page (rather than relying on the missing-row fallback).
  const cutoff = enabledCount ?? Math.ceil(instrumentIds.length / 2);
  const rows = instrumentIds.map((instrumentId, idx) => ({
    userId,
    instrumentId,
    enabled: idx < cutoff,
  }));
  await db.insert(schema.instrumentNotificationSubscriptions).values(rows);
}

// ---------------------------------------------------------------------------
// Notifications — a believable steady state for the bell popover:
//   - Today bucket: two comment notifications from the same teammate so the
//     "mentioned you" + follow-up pattern (mirroring the design mock) lands
//     under the TODAY header.
//   - Yesterday bucket: three groups of `run_created` notifications (3 + 3
//     + 2 rows across three different instruments) so the grouped-row
//     variant of the popover renders with a comma-separated run-id list
//     under each instrument heading.
//   - Earlier bucket: one already-read `comment_participated` row so the
//     read-vs-unread visual contrast and the "Earlier" section both show
//     up after the first popover open.
//
// All notifications target a single recipient (the dev user). Comments
// authored by the teammates are inserted here as well so the popover can
// surface their body preview without depending on `seedRunComments`
// having already inserted teammate comments — that builder only seeds
// dev-user comments to satisfy the comment_participated precondition.
// ---------------------------------------------------------------------------

export interface SeededNotifications {
  total: number;
  unread: number;
}

export async function seedNotifications(
  db: Db,
  input: {
    recipientUserId: string;
    runs: SeededRun[];
    teammates: SeededTeammate[];
  }
): Promise<SeededNotifications> {
  const { recipientUserId, runs, teammates } = input;
  if (runs.length === 0 || teammates.length === 0) {
    return { total: 0, unread: 0 };
  }

  const now = new Date();
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  // Anchor against the calendar boundary so the seeded `createdAt`s always
  // land in the intended popover bucket regardless of the wall-clock time
  // a developer runs `db:seed`.
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  // Group seeded runs by instrument so we can carve out per-instrument
  // batches for the grouped `run_created` rows.
  const runsByInstrument = new Map<string, SeededRun[]>();
  for (const run of runs) {
    const list = runsByInstrument.get(run.instrumentId) ?? [];
    list.push(run);
    runsByInstrument.set(run.instrumentId, list);
  }
  const instrumentIds = [...runsByInstrument.keys()];

  type NotifInsert = typeof schema.notifications.$inferInsert;
  const notifRows: NotifInsert[] = [];

  // -------------------------------------------------------------------------
  // Teammate-authored comments + matching `comment_attributed` rows.
  // Pre-allocating the comment UUIDs lets us batch the notification insert
  // below without a round-trip to fetch the comment ids back.
  // -------------------------------------------------------------------------

  const primaryTeammate = teammates[0];
  const todayCommentTargets = runs.slice(0, 2);
  const todayCommentBodies = [
    "@dev can you take a look at the OD readings on plate 3? Something looks off…",
    "Nevermind — I see what happened. The well was contaminated.",
  ];

  type CommentInsert = typeof schema.runComments.$inferInsert;
  const todayComments: CommentInsert[] = todayCommentTargets.map((run, i) => ({
    id: crypto.randomUUID(),
    runId: run.id,
    userId: primaryTeammate.id,
    body: todayCommentBodies[i],
    // Both ~20h ago — same actor + same day mirrors the design mock.
    createdAt: new Date(now.getTime() - (20 - i * 0.25) * HOUR),
  }));
  await db.insert(schema.runComments).values(todayComments);

  for (const comment of todayComments) {
    notifRows.push({
      userId: recipientUserId,
      type: "comment_attributed",
      runId: comment.runId,
      commentId: comment.id ?? null,
      actorUserId: comment.userId,
      createdAt: comment.createdAt,
      readAt: null,
    });
  }

  // -------------------------------------------------------------------------
  // Yesterday: grouped `run_created` rows across three instruments. The
  // popover collapses notifications sharing (bucket, instrumentId) into a
  // single row, so emitting 3 / 3 / 2 here yields three grouped rows.
  // -------------------------------------------------------------------------

  // Within "yesterday" the bell sorts the group by latest createdAt; we
  // stamp these between 6PM and 6AM yesterday so the bucket assignment is
  // unambiguous regardless of `now`.
  const yesterdayBaseline = new Date(startOfToday.getTime() - 6 * HOUR);

  const groupBatches: Array<{ instrumentIdx: number; count: number }> = [
    { instrumentIdx: 0, count: 3 },
    { instrumentIdx: 1, count: 3 },
    { instrumentIdx: 2, count: 2 },
  ];

  groupBatches.forEach((batch, batchIdx) => {
    const instrumentId = instrumentIds[batch.instrumentIdx];
    if (!instrumentId) {
      return;
    }
    const pool = runsByInstrument.get(instrumentId) ?? [];
    const picks = pool.slice(0, batch.count);
    picks.forEach((run, i) => {
      notifRows.push({
        userId: recipientUserId,
        type: "run_created",
        runId: run.id,
        // Stagger each group's stamps within a separate ~1h window so the
        // grouped row's "latest" anchor differs between batches and the
        // ordering inside the popover stays deterministic.
        createdAt: new Date(
          yesterdayBaseline.getTime() - (batchIdx * HOUR + i * 5 * 60_000)
        ),
        readAt: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Earlier: one already-read `comment_participated` row to exercise both
  // the "Earlier" bucket and the read-row treatment (dimmed background, no
  // left rail). The dev user has a seeded comment on every run via
  // `seedRunComments`, so any run qualifies for the participated trigger.
  // -------------------------------------------------------------------------

  const earlierTarget = runs[Math.min(4, runs.length - 1)];
  const earlierReply: CommentInsert = {
    id: crypto.randomUUID(),
    runId: earlierTarget.id,
    userId: primaryTeammate.id,
    body: "Following up — do you want to re-run with fresh standards before we sign this off?",
    createdAt: new Date(startOfToday.getTime() - 3 * DAY),
  };
  await db.insert(schema.runComments).values([earlierReply]);

  notifRows.push({
    userId: recipientUserId,
    type: "comment_participated",
    runId: earlierTarget.id,
    commentId: earlierReply.id ?? null,
    actorUserId: primaryTeammate.id,
    createdAt: earlierReply.createdAt,
    // Marked read so the popover renders both a read and the unread rows
    // above for visual contrast.
    readAt: new Date(startOfToday.getTime() - 2 * DAY),
  });

  await db.insert(schema.notifications).values(notifRows);

  const unread = notifRows.filter((r) => r.readAt == null).length;
  return { total: notifRows.length, unread };
}

// ---------------------------------------------------------------------------
// Archive jobs — one row in each lifecycle state so the download-archive UI
// renders every variant.
// ---------------------------------------------------------------------------

export async function seedArchiveJobs(
  db: Db,
  runs: SeededRun[],
  createdBy?: string
): Promise<void> {
  if (runs.length === 0) {
    return;
  }

  const statuses = ["ready", "building", "failed"] as const;
  const rows = statuses.slice(0, runs.length).map((status, i) => {
    const run = runs[i];
    return {
      instrumentRunId: run.id,
      fingerprint: `seed-fingerprint-${run.runId}`,
      archiveBucket: status === "ready" ? ARCHIVES_BUCKET : null,
      archiveKey:
        status === "ready"
          ? `runs/${run.instrumentId}/${run.runId}/seed.zip`
          : null,
      sizeBytes: status === "ready" ? 1_048_576 : null,
      status,
      errorMessage: status === "failed" ? "Seeded archive build failure" : null,
      createdBy: createdBy ?? null,
      completedAt:
        status === "ready" || status === "failed" ? new Date() : null,
    };
  });
  await db.insert(schema.archiveJobs).values(rows);
}
