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

import { generateToken, getTokenPrefix, hashToken } from "@/lib/tokens";
import { getTableName, isTable, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

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

  if (tableNames.length === 0) return;

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

export type SeedUserOptions = {
  email?: string;
  name?: string;
  isAdmin?: boolean;
  // Permission scopes for the minted PAT. Defaults to `["*"]` so the
  // returned token can hit every v1 route — matches the historical test
  // behavior. Pass an explicit list to exercise scope enforcement.
  scopes?: string[];
  // Optional PAT expiry. NULL (the default) means no expiry.
  expiresAt?: Date | null;
};

export type SeedUserResult = {
  userId: string;
  email: string;
  token: string;
};

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
    expiresAt: options.expiresAt !== undefined ? options.expiresAt : null,
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

export type SeededInstrument = {
  id: string;
  displayName: string;
  instrumentType: schema.InstrumentType;
  status: "pending" | "active" | "inactive";
};

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

export async function seedInstruments(db: Db): Promise<SeededInstrument[]> {
  const rows: SeededInstrument[] = schema.VALID_INSTRUMENT_TYPES.map(
    (type, idx) => ({
      id: `seed-${type.replace(/_/g, "-")}`,
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

export type SeededWatcher = {
  id: string;
  instrumentId: string;
  status: "registered" | "watching" | "stopped";
};

const WATCHER_STATUSES = ["watching", "registered", "stopped"] as const;

export async function seedWatchers(
  db: Db,
  instrumentIds: string[]
): Promise<SeededWatcher[]> {
  if (instrumentIds.length === 0) return [];

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
// Runs + files — fake S3 keys under a `test-raw-data-bucket` namespace so
// signed-URL generation works locally (signing is HMAC-only). Actually
// fetching the files won't work without real S3, which is documented in
// docs/local-development.md.
// ---------------------------------------------------------------------------

export type SeededRun = {
  id: string;
  instrumentId: string;
  runId: string;
};

const FILE_STATUSES = ["uploaded", "completed", "failed"] as const;

export async function seedRuns(
  db: Db,
  instrumentId: string,
  count: number = 5
): Promise<SeededRun[]> {
  if (count <= 0) return [];

  const now = new Date();
  const runValues = Array.from({ length: count }, (_, i) => {
    const acquiredAt = new Date(now.getTime() - (i + 1) * 24 * 60 * 60_000);
    return {
      instrumentId,
      runId: `seed-run-${i + 1}`,
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

  const fileRows = runs.flatMap((run, runIdx) =>
    Array.from({ length: 3 }, (_, fi) => {
      const status = FILE_STATUSES[(runIdx + fi) % FILE_STATUSES.length];
      const category = fi === 2 ? ("processed" as const) : ("raw" as const);
      const filename = `${category}_${fi + 1}.csv`;
      return {
        instrumentRunId: run.id,
        relativePath: filename,
        s3Bucket: "test-raw-data-bucket",
        s3Key: `${run.instrumentId}/${run.runId}/${filename}`,
        filename,
        contentType: "text/csv",
        sizeBytes: 1024 * (fi + 1),
        category,
        status,
        metadata: { seeded: true },
        errorMessage:
          status === "failed" ? "Seeded failure for UI exercise" : null,
        uploadedAt: status !== "failed" ? new Date() : null,
        processedAt: status === "completed" ? new Date() : null,
      };
    })
  );
  await db.insert(schema.files).values(fileRows);

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
  if (runs.length === 0) return;
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
  if (runs.length === 0) return;
  const rows = runs.map((run) => ({ runId: run.id, userId }));
  await db.insert(schema.runAttributions).values(rows);
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
  if (runs.length === 0) return;

  const statuses = ["ready", "building", "failed"] as const;
  const rows = statuses.slice(0, runs.length).map((status, i) => {
    const run = runs[i];
    return {
      instrumentRunId: run.id,
      fingerprint: `seed-fingerprint-${run.runId}`,
      archiveBucket: status === "ready" ? "test-archives-bucket" : null,
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
