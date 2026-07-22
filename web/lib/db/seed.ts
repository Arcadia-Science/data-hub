// Shared seed builders used by both the local dev seed script
// (`scripts/seed-database.ts` → `npm run db:seed`) and the integration test
// helpers (`tests/integration/helpers.ts`). Centralizing them in `lib/`
// keeps the token-generation logic, instrument catalog, and TRUNCATE list
// in sync between the two consumers — adding a new table to the schema
// only requires updating this file.
//
// The functions are intentionally minimal and deterministic: no Faker, no
// randomness beyond UUIDs / token bytes. Bug reports against a seeded
// database should be reproducible from the same seed call sequence.

import { createHash } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName, isTable, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  startOfLastWeekEndDayISO,
  startOfLastWeekISO,
  startOfMonthISO,
  startOfTodayISO,
  startOfWeekISO,
} from "@/lib/date";
import { generateToken, getTokenPrefix, hashToken } from "@/lib/tokens";
// biome-ignore lint/performance/noNamespaceImport: seed needs the full schema module for Db typing and table iteration
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

// Bucket name shared with the lambda CLI's `data-hub-process handler`
// (`--raw-bucket` default). Exporting the constant means the seed and
// the CLI never drift — both the row's `s3_bucket` field and the
// directory under `LOCAL_S3_MIRROR` use the same string.
export const RAW_BUCKET = "test-raw-data-bucket";
export const ARCHIVES_BUCKET = "test-archives-bucket";

// Stable admin identity for local sign-in / fixture processing. Emails use
// `@example.com` so docs screenshots look like real accounts without
// implying a real domain.
export const SEED_ADMIN_EMAIL = "alice@example.com";
export const SEED_ADMIN_NAME = "Alice Zimmerman";

// Matches production watcher builds so the update-check UI doesn't nag
// during docs screenshots. Integration tests keep the historical 9.9.9
// default via `seedWatcherReleaseConfig`'s parameter default.
export const SEED_WATCHER_VERSION = "0.5.3";

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
  // PAT row id — used by watcher-binding tests that assert
  // `watchers.registered_by_token` matches the registering credential.
  tokenId: string;
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
  const [pat] = await db
    .insert(schema.personalAccessTokens)
    .values({
      userId,
      name: "seeded-token",
      tokenHash: hashToken(plaintext),
      tokenPrefix: getTokenPrefix(plaintext),
      scopes: options.scopes ?? ["*"],
      expiresAt: options.expiresAt === undefined ? null : options.expiresAt,
    })
    .returning({ id: schema.personalAccessTokens.id });

  return { userId, email, token: plaintext, tokenId: pat.id };
}

// ---------------------------------------------------------------------------
// Watcher release config — singleton row consulted by the
// `/api/v1/watchers/:id/update-check` endpoint. Tests and the dev seed both
// want a stable baseline so the endpoint returns deterministic values.
// ---------------------------------------------------------------------------

export async function seedWatcherReleaseConfig(
  db: Db,
  options: {
    latestVersion?: string;
    minSupportedVersion?: string;
  } = {}
): Promise<void> {
  const latestVersion = options.latestVersion ?? "9.9.9";
  const minSupportedVersion = options.minSupportedVersion ?? "0.1.0";
  await db.execute(
    sql`INSERT INTO watcher_release_config
       (id, latest_version, min_supported_version, mandatory)
     VALUES
       (true, ${latestVersion}, ${minSupportedVersion}, false)
     ON CONFLICT (id) DO UPDATE SET
       latest_version = EXCLUDED.latest_version,
       min_supported_version = EXCLUDED.min_supported_version,
       mandatory = EXCLUDED.mandatory,
       updated_at = now(),
       updated_by = NULL`
  );
}

// Singleton row for org-wide Slack channel notifications. Integration tests
// pass the in-process capture-server URL; the dev seed leaves it unset so
// channel notifications stay disabled until an admin configures the webhook.
export async function seedSlackChannelConfig(
  db: Db,
  webhookUrl: string | null = null
): Promise<void> {
  await db.execute(
    sql`INSERT INTO slack_channel_config (id, webhook_url)
     VALUES (true, ${webhookUrl})
     ON CONFLICT (id) DO UPDATE SET
       webhook_url = EXCLUDED.webhook_url,
       updated_at = now(),
       updated_by = NULL`
  );
}

// ---------------------------------------------------------------------------
// Instruments — mirrors the production catalog (ids + display names) so docs
// screenshots look real, plus one pending instrument for the activate-
// instrument admin UI. `azure-cielo-qpcr` stays typed as `qpcr` locally so
// fixture processing still runs even though prod currently marks it generic.
// ---------------------------------------------------------------------------

export interface SeededInstrument {
  // Watcher config YAML snapped from production, with `{{WATCHER_ID}}`
  // substituted at seed time so the Configuration tab shows a real
  // instrument block (watch dir, patterns, run detection) instead of a
  // placeholder comment.
  configYamlTemplate: string;
  displayName: string;
  hostname: string;
  id: string;
  instrumentType: schema.InstrumentType;
  osInfo: string;
  status: "pending" | "active" | "inactive";
  watcherStatus: "registered" | "watching" | "stopped";
}

// Shared local preamble so seeded configs point at the dev API rather than
// production URLs / UUIDs. Instrument blocks below are production snapshots.
function localWatcherConfigPreamble(): string {
  return `version: 1
environment: local
api_base_urls:
  local: http://localhost:3000/api/v1
watcher_ids:
  local: {{WATCHER_ID}}
initial_scan: null
`;
}

function buildSeedConfigYaml(instrumentBlock: string): string {
  return `${localWatcherConfigPreamble()}${instrumentBlock}`;
}

function renderWatcherConfig(
  template: string,
  watcherId: string
): { configChecksum: string; configYaml: string } {
  const configYaml = template.replaceAll("{{WATCHER_ID}}", watcherId);
  const configChecksum = `sha256:${createHash("sha256").update(configYaml).digest("hex")}`;
  return { configYaml, configChecksum };
}

// Production hostnames / display names / watcher configs, snapshotted for
// local realism. Pending row is local-only (prod has no pending instruments).
export const SEED_INSTRUMENTS: readonly SeededInstrument[] = [
  {
    id: "agilent-4150-tapestation",
    displayName: "Agilent 4150 TapeStation",
    instrumentType: "tape_station",
    status: "active",
    hostname: "DESKTOP-85DT2MG",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: agilent-4150-tapestation
  watch_directory: C:\\Users\\Arcadia User\\Documents\\Agilent\\TapeStation Data
  file_patterns:
  - '*.pdf'
  - '*.csv'
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  upload_parallelism: 4
  run_detection:
    pattern: ([^/]+)/[^/]+$
    recursive: true
`),
  },
  {
    id: "unchained-labs-aunty",
    displayName: "Aunty",
    instrumentType: "generic",
    status: "active",
    hostname: "Aunty-1075",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: unchained-labs-aunty
  watch_directory: C:\\Aunty\\Export
  file_patterns:
  - '*.xlsx'
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  upload_parallelism: 4
  run_detection:
    pattern: (\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})
    recursive: true
`),
  },
  {
    id: "azure-600-gel-doc",
    displayName: "Azure 600 Gel Doc",
    instrumentType: "gel_doc",
    status: "active",
    hostname: "WIN-G7U3JO19L7O",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: azure-600-gel-doc
  watch_directory: C:\\Data
  file_patterns:
  - '*.tif'
  - .*jpg
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  upload_parallelism: 4
  run_detection:
    pattern: ^(?:.+/)?([^/]+?)\\.[^/.]+$
    recursive: false
`),
  },
  {
    id: "azure-cielo-qpcr",
    displayName: "Azure Cielo qPCR",
    instrumentType: "qpcr",
    status: "active",
    hostname: "DESKTOP-7JE1NCI",
    osInfo: "Windows 10",
    watcherStatus: "stopped",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: azure-cielo-qpcr
  watch_directory: C:\\Users\\Public\\Documents\\Azure Biosystems\\Azure qPCR
  file_patterns:
  - '*.csv'
  - '*.pdf'
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  run_detection:
    pattern: (Experiment_\\d{8}(?:\\d{6})?)
    recursive: true
`),
  },
  {
    id: "epson-v700-scanner",
    displayName: "Epson v700 Scanner",
    instrumentType: "epson_v700_scanner",
    status: "active",
    hostname: "WIN-G7U3JO19L7O",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: epson-v700-scanner
  watch_directory: C:\\Users\\raymo\\ScanData
  file_patterns:
  - '*.tif'
  - '*.tiff'
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  upload_parallelism: 4
  run_detection:
    pattern: ^(?:.+/)?([^/]+?)\\.[^/.]+$
    recursive: true
`),
  },
  {
    id: "hina-microscope",
    displayName: "Hina Microscope",
    instrumentType: "hina_microscope",
    status: "active",
    hostname: "DESKTOP-2UV5Q0A",
    osInfo: "Windows 10",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: hina-microscope
  watch_directory: D:\\ArcadiaJOBS2026
  file_patterns:
  - '*.nd2'
  enabled: true
  upload_mode: manual
  stability_period_seconds: 10
  upload_parallelism: 4
  run_detection:
    pattern: ([^/]+)/[^/]+$
    recursive: true
`),
  },
  {
    id: "instantraman",
    displayName: "InstantRaman",
    instrumentType: "instant_raman",
    status: "active",
    hostname: "DESKTOP-5B1P1V5",
    osInfo: "Windows 10",
    watcherStatus: "stopped",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: instantraman
  watch_directory: \\\\ARC-NAS-01\\Microscopy\\Wasatch-Raman_785
  file_patterns:
  - '*.csv'
  - '*.json'
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  upload_parallelism: 4
  run_detection:
    pattern: ([^/]+)/[^/]+$
    recursive: true
`),
  },
  {
    id: "jolene-fplc",
    displayName: "Jolene FPLC",
    instrumentType: "generic",
    status: "active",
    hostname: "DESKTOP-30488S0",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: jolene-fplc
  watch_directory: C:\\Users\\Peanut\\Documents
  file_patterns:
  - '*.csv'
  - '*.pdf'
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  upload_parallelism: 4
  run_detection:
    pattern: (?:^|/)(\\d{6})
    recursive: true
`),
  },
  {
    id: "spectramax-id3-plate-reader",
    displayName: "SpectraMax iD3 Plate Reader",
    instrumentType: "plate_reader",
    status: "active",
    hostname: "DESKTOP-13T085J",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: spectramax-id3-plate-reader
  watch_directory: C:\\Users\\LabEquipment\\Documents\\SMP73
  file_patterns:
  - '*.xls'
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  upload_parallelism: 4
  run_detection:
    pattern: ^(?:.+/)?([^/]+?)\\.[^/.]+$
    recursive: false
`),
  },
  {
    id: "spectramax-id5-plate-reader",
    displayName: "SpectraMax iD5 Plate Reader",
    instrumentType: "plate_reader",
    status: "active",
    hostname: "iD5_SpectraMax",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: spectramax-id5-plate-reader
  watch_directory: C:\\Users\\LabEquipment\\Documents\\SMP74
  file_patterns:
  - '*.xls'
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  upload_parallelism: 4
  run_detection:
    pattern: ^(?:.+/)?([^/]+?)\\.[^/.]+$
    recursive: false
`),
  },
  {
    id: "seed-pending-instrument",
    displayName: "Pending Lab Instrument",
    instrumentType: "generic",
    status: "pending",
    hostname: "LAB-PC-PENDING",
    osInfo: "Windows 11",
    watcherStatus: "registered",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: seed-pending-instrument
  watch_directory: C:\\Data\\PendingInstrument
  file_patterns:
  - '*.csv'
  enabled: true
  upload_mode: auto
  stability_period_seconds: 5
  upload_parallelism: 4
  run_detection:
    pattern: ^(?:.+/)?([^/]+?)\\.[^/.]+$
    recursive: true
`),
  },
];

// Instrument ids that have a real lambda `process_file` pipeline. Kept as a
// type→id map for callers that still think in instrument types; fixtures
// themselves are keyed by instrument id below so both SpectraMax readers
// can share the same `.xls` fixture under distinct ids.
export const CANONICAL_INSTRUMENT_ID: Partial<
  Record<schema.InstrumentType, string>
> = {
  qpcr: "azure-cielo-qpcr",
  gel_doc: "azure-600-gel-doc",
  plate_reader: "spectramax-id3-plate-reader",
};

export async function seedInstruments(db: Db): Promise<SeededInstrument[]> {
  const rows = SEED_INSTRUMENTS.map(
    ({ id, displayName, instrumentType, status }) => ({
      id,
      displayName,
      instrumentType,
      status,
    })
  );
  await db.insert(schema.instruments).values(rows);
  return [...SEED_INSTRUMENTS];
}

// ---------------------------------------------------------------------------
// Watchers + heartbeats + events
// ---------------------------------------------------------------------------

export interface SeededWatcher {
  id: string;
  instrumentId: string;
  status: "registered" | "watching" | "stopped";
}

export async function seedWatchers(
  db: Db,
  instruments: SeededInstrument[]
): Promise<SeededWatcher[]> {
  // Mirror the register endpoint: only active and pending instruments accept a
  // watcher. A pending instrument is seeded with a `registered` watcher (no
  // heartbeats) to model the realistic "watcher registered, awaiting admin
  // activation" state — instruments only ever exist because a watcher
  // registered against them, so a pending instrument with no watcher is a
  // state the real system can't produce.
  const eligible = instruments.filter(
    (i) => i.status === "active" || i.status === "pending"
  );
  if (eligible.length === 0) {
    return [];
  }

  const now = new Date();
  const watcherValues = eligible.map((instrument) => {
    const status =
      instrument.status === "pending"
        ? ("registered" as const)
        : instrument.watcherStatus;
    const id = crypto.randomUUID();
    const { configYaml, configChecksum } = renderWatcherConfig(
      instrument.configYamlTemplate,
      id
    );
    return {
      id,
      instrumentId: instrument.id,
      hostname: instrument.hostname,
      osInfo: instrument.osInfo,
      watcherVersion: SEED_WATCHER_VERSION,
      configChecksum,
      configYaml,
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
        message: "Uploaded latest run files to S3",
        details: {},
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
// dashboard out of the box. Other instruments get realistic filenames
// (no bytes) patterned after production.
// ---------------------------------------------------------------------------

export interface SeededRun {
  id: string;
  instrumentId: string;
  runId: string;
}

type SeedFileStatus = "uploaded" | "completed" | "failed";

interface SyntheticFileSpec {
  category: "raw" | "processed";
  contentType: string;
  filename: string;
  sizeBytes?: number;
}

interface SyntheticRunShape {
  filesForRun: (runId: string, runIdx: number) => SyntheticFileSpec[];
  metadataForRun?: (runId: string, runIdx: number) => Record<string, unknown>;
  runIds: readonly string[];
}

// Prefer healthy runs for docs screenshots. Exactly one failed run and one
// uploaded run per instrument — the old status cycle painted every
// multi-file run red because at least one file always landed on `failed`.
function seedFileStatus(runIdx: number, fileIdx: number): SeedFileStatus {
  // One failed run (first file only) so the status filter / icon still show.
  if (runIdx === 5 && fileIdx === 0) {
    return "failed";
  }
  // One uploaded-but-unprocessed run for status variety.
  if (runIdx === 2) {
    return "uploaded";
  }
  return "completed";
}

const FILE_INSERT_CHUNK = 500;
// Typical Hina .nd2 size from production (~30.7 MiB).
const HINA_ND2_BYTES = 32_190_464;
// File counts per seeded Hina run — large enough for tens–hundreds of GB
// on the bigger runs without making every reseed take minutes.
const HINA_FILE_COUNTS = [270, 864, 120, 480, 2000, 216, 972, 96] as const;

function hinaNd2Files(count: number): SyntheticFileSpec[] {
  return Array.from({ length: count }, (_, i) => {
    const wellRow = String.fromCharCode(65 + (Math.floor(i / 12) % 8));
    const wellCol = String((i % 12) + 1).padStart(2, "0");
    const well = `${wellRow}${wellCol}`;
    const pointIdx = String(i % 9).padStart(4, "0");
    const seq = String(i).padStart(4, "0");
    return {
      filename: `Well${well}_Point${well}_${pointIdx}_Channelbrightfield,FITC BP,TRITC BP_Seq${seq}.nd2`,
      contentType: "image/nd2",
      category: "raw" as const,
      sizeBytes: HINA_ND2_BYTES,
    };
  });
}

function hinaRunMetadata(runIdx: number): Record<string, unknown> {
  const withZ = runIdx % 3 === 1;
  return {
    sizes: withZ
      ? { C: 3, X: 2304, Y: 2304, Z: 5 }
      : { C: 3, X: 2304, Y: 2304 },
    channels: [
      {
        name: "BRIGHTFIELD",
        color: "#ffffff",
        emission_nm: null,
        excitation_nm: null,
      },
      {
        name: "FITC",
        color: "#07ff00",
        emission_nm: 512,
        excitation_nm: 488,
      },
      {
        name: "TRITC",
        color: "#ffbf00",
        emission_nm: 595,
        excitation_nm: 561,
      },
    ],
    dimensions: withZ ? ["MULTICHANNEL", "Z_STACK"] : ["MULTICHANNEL"],
  };
}

function instantRamanFiles(siteCount: number): SyntheticFileSpec[] {
  const wells = ["A01", "B05", "C10", "D03", "E08", "F12", "G02", "H10"];
  const files: SyntheticFileSpec[] = [];
  for (let i = 0; i < siteCount; i++) {
    const well = wells[i % wells.length];
    const site = Math.floor(i / wells.length);
    files.push(
      {
        filename: `${well}-Site_${site}.csv`,
        contentType: "text/csv",
        category: "raw",
        sizeBytes: 93_000,
      },
      {
        filename: `${well}-Site_${site}.json`,
        contentType: "application/json",
        category: "raw",
        sizeBytes: 4300,
      }
    );
  }
  return files;
}

export interface InstrumentFixture {
  contentType: string;
  filename: string;
  runIds: readonly string[];
}

// Keyed by instrument id (not type) so both SpectraMax readers can share
// the same fixture file under distinct ids / run-id lists.
export const INSTRUMENT_FIXTURES: Record<string, InstrumentFixture> = {
  "azure-cielo-qpcr": {
    filename: "azure_cielo_qpcr_example.csv",
    contentType: "text/csv",
    runIds: [
      "Experiment_20260129",
      "Experiment_20260122",
      "Experiment_20260115",
      "Experiment_20260108",
      "Experiment_20260101",
      "Experiment_20251225",
      "Experiment_20251218",
      "Experiment_20251211",
    ],
  },
  "azure-600-gel-doc": {
    filename: "azure_600_gel_doc_example.tif",
    contentType: "image/tiff",
    runIds: [
      "26.02.02_10.45.05",
      "26.01.26_15.10.30",
      "26.01.19_11.05.42",
      "26.01.12_14.22.18",
      "26.01.05_09.30.00",
      "25.12.29_16.40.00",
      "25.12.22_13.15.00",
      "25.12.15_10.00.00",
    ],
  },
  "spectramax-id3-plate-reader": {
    filename: "spectramax_plate_reader_endpoint.xls",
    contentType: "application/vnd.ms-excel",
    runIds: [
      "012926_AR_OD600",
      "012226_DK_OD750",
      "011526_AR_GFP_endpoint",
      "010826_DK_OD600",
      "010126_AR_OD750",
      "122525_DK_OD600",
      "121825_AR_OD750",
      "121125_DK_GFP_endpoint",
    ],
  },
  "spectramax-id5-plate-reader": {
    filename: "spectramax_plate_reader_endpoint.xls",
    contentType: "application/vnd.ms-excel",
    runIds: [
      "260721_bradford_AAA",
      "260720_OD600_BBB",
      "260716_BCA_CCC",
      "260714_fluo_DDD",
      "260710_OvernightOD_EEE",
      "260705_GFP_FFF",
      "260628_OD750_GGG",
      "260620_endpoint_HHH",
    ],
  },
};

// Filename / run-id patterns snapped from production shapes, with synthetic
// stems so we never echo real lab filenames into the repo.
const SYNTHETIC_RUN_SHAPES: Record<string, SyntheticRunShape> = {
  "agilent-4150-tapestation": {
    // Prod-shaped timestamps/assay suffixes; dates chosen to avoid real runs.
    runIds: [
      "2026-03-15 - 09-15-22-gDNA",
      "2026-03-14 - 11-42-08-gDNA",
      "2026-03-14 - 13-08-33-HSD1000",
      "2026-03-12 - 10-21-45-gDNA",
      "2026-03-11 - 15-04-12-gDNA",
      "2026-03-10 - 14-36-51-HSD1000",
      "2026-03-09 - 11-18-07-gDNA",
      "2026-03-08 - 09-52-39-gDNA",
    ],
    filesForRun: (runId) => {
      const pdfStem = runId.replace(/-(\d{2})-(\d{2})-(\d{2})/, ".$1.$2.$3");
      return [
        {
          filename: `${runId}_compactPeakTable.csv`,
          contentType: "text/csv",
          category: "raw",
        },
        {
          filename: `${runId}_Electropherogram.csv`,
          contentType: "text/csv",
          category: "raw",
        },
        {
          filename: `${runId}_sampleTable.csv`,
          contentType: "text/csv",
          category: "raw",
        },
        {
          filename: `${pdfStem}.pdf`,
          contentType: "application/pdf",
          category: "raw",
        },
      ];
    },
  },
  "unchained-labs-aunty": {
    // Prod-shaped ISO-ish stems; timestamps chosen to avoid real runs.
    runIds: [
      "2026-03-15T09-22-11",
      "2026-03-15T09-18-44",
      "2026-03-14T14-05-33",
      "2026-03-13T16-41-09",
      "2026-03-12T11-27-52",
      "2026-03-11T10-13-28",
      "2026-03-10T15-56-07",
      "2026-03-09T08-34-19",
    ],
    filesForRun: (runId) => [
      {
        filename: `Aunty_export_${runId}.xlsx`,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        category: "raw",
      },
    ],
  },
  "jolene-fplc": {
    runIds: [
      "260721",
      "260714",
      "260707",
      "260630",
      "260623",
      "260616",
      "260609",
      "260602",
    ],
    filesForRun: (runId) => [
      {
        filename: `${runId}_fraction-tables.pdf`,
        contentType: "application/pdf",
        category: "raw",
      },
      {
        filename: `${runId}_chromatogram.pdf`,
        contentType: "application/pdf",
        category: "raw",
      },
      {
        filename: `${runId}_fraction-tables.csv`,
        contentType: "text/csv",
        category: "raw",
      },
      {
        filename: `${runId}_chromatogram.csv`,
        contentType: "text/csv",
        category: "raw",
      },
    ],
  },
  "hina-microscope": {
    // Prod-shaped YYYYMMDD_HHMMSS_### stems; stamps chosen to avoid real runs.
    runIds: [
      "20260315_091522_101",
      "20260314_114208_214",
      "20260313_130833_307",
      "20260312_152145_418",
      "20260311_100412_522",
      "20260310_143651_633",
      "20260309_111807_744",
      "20260308_095239_855",
    ],
    // Hundreds–thousands of .nd2 files at ~30 MiB each so totals land in
    // the tens of GB (and ~60 GB on the largest run), matching production.
    filesForRun: (_runId, runIdx) =>
      hinaNd2Files(HINA_FILE_COUNTS[runIdx] ?? 96),
    metadataForRun: (_runId, runIdx) => hinaRunMetadata(runIdx),
  },
  "epson-v700-scanner": {
    runIds: [
      "20260715_AAA_003",
      "20260715_AAA_002",
      "20260715_AAA_001",
      "20260713_BBB_ref_dips_300dpi_003",
      "20260709_CCC_kinetic_endpoint_300dpi_002",
      "20260707_DDD_replica_plate1_300dpi001",
      "20260707_DDD_replica_plate2_600dpi001",
      "20260701_EEE_colony_screen_300dpi001",
    ],
    filesForRun: (runId) => [
      {
        filename: `${runId}.tif`,
        contentType: "image/tiff",
        category: "raw",
      },
    ],
  },
  instantraman: {
    // Prod-shaped freeform experiment names; none copied from production.
    runIds: [
      "yeast_plate_a_785",
      "yeast_plate_b_830",
      "biotin_droplet_rep1",
      "culture_dilution_001",
      "culture_dilution_002",
      "dmso_control_rep1",
      "steel_blank_series_rep1",
      "dried_spot_series_a",
    ],
    // Hundreds of csv/json site pairs per run (production often has 200–4000+).
    filesForRun: (_runId, runIdx) =>
      instantRamanFiles([120, 250, 80, 400, 180, 60, 300, 90][runIdx] ?? 100),
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Calendar-relative `acquired_at` timestamps so local reseeds exercise the
 * dashboard date presets (Today / Yesterday / This week / Last 7 days / …)
 * and the today / this-week stat cards. Uses the host IANA timezone — the
 * same zone the browser cookie syncs for local `make db-reseed` workflows.
 */
function seedAcquiredAtSchedule(now: Date = new Date()): Date[] {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStart = new Date(startOfTodayISO(timeZone, now)).getTime();
  const weekStart = new Date(startOfWeekISO(timeZone, now)).getTime();
  const lastWeekStart = new Date(startOfLastWeekISO(timeZone, now)).getTime();
  const lastWeekSunday = new Date(
    startOfLastWeekEndDayISO(timeZone, now)
  ).getTime();
  const monthStart = new Date(startOfMonthISO(timeZone, now)).getTime();

  // Prefer Tuesday noon of this week; on Mon/Tue fall back to shortly after
  // week start so the stamp stays in "this week" and still before `now`.
  let earlierThisWeek = weekStart + 1.5 * DAY_MS;
  if (earlierThisWeek >= todayStart) {
    earlierThisWeek = weekStart + HOUR_MS;
  }
  if (earlierThisWeek >= now.getTime()) {
    earlierThisWeek = now.getTime() - 30 * 60_000;
  }

  // Earlier this month, preferably outside the rolling 14-day window so
  // "This month" and "Last 2 weeks" diverge. Clamp into the month when
  // reseeding early in the calendar month.
  let earlierThisMonth = now.getTime() - 16 * DAY_MS;
  if (earlierThisMonth < monthStart) {
    earlierThisMonth = monthStart + HOUR_MS;
  }
  if (earlierThisMonth >= now.getTime()) {
    earlierThisMonth = now.getTime() - HOUR_MS;
  }

  return [
    new Date(now.getTime() - 2 * HOUR_MS), // Today
    new Date(todayStart - 12 * HOUR_MS), // Yesterday
    new Date(earlierThisWeek), // This week (not today)
    new Date(lastWeekStart + 2.5 * DAY_MS), // Last 7 days / prior calendar week
    new Date(lastWeekSunday + 12 * HOUR_MS), // Last 7–14 days
    new Date(now.getTime() - 10 * DAY_MS), // Last 2 weeks (rolling)
    new Date(now.getTime() - 22 * DAY_MS), // Last 4 weeks (rolling)
    new Date(earlierThisMonth), // This month / older custom ranges
  ];
}

export async function seedRuns(
  db: Db,
  instrumentId: string,
  count = 8
): Promise<SeededRun[]> {
  if (count <= 0) {
    return [];
  }

  const fixture = INSTRUMENT_FIXTURES[instrumentId];
  const synthetic = SYNTHETIC_RUN_SHAPES[instrumentId];
  const runIds = (fixture?.runIds ?? synthetic?.runIds)?.slice(0, count);

  // Place runs on calendar-aware stamps so Today / Yesterday / This week /
  // Last 7 days / Last 2 weeks / This month / Last 4 weeks presets each return
  // a non-empty, differing set after a local reseed.
  const schedule = seedAcquiredAtSchedule();
  const runValues = Array.from({ length: count }, (_, i) => {
    const acquiredAt =
      schedule[i] ?? new Date(Date.now() - (i + 1) * 3 * DAY_MS);
    const runId = runIds?.[i] ?? `run-${i + 1}`;
    const extraMeta = synthetic?.metadataForRun?.(runId, i) ?? {};
    return {
      instrumentId,
      runId,
      source: (i % 2 === 0 ? "lambda" : "watcher") as "lambda" | "watcher",
      metadata: { seeded: true, ...extraMeta },
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

  const fileRows = fixture
    ? runs.map((run, runIdx) => {
        const status = seedFileStatus(runIdx, 0);
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
    : runs.flatMap((run, runIdx) => {
        const specs =
          synthetic?.filesForRun(run.runId, runIdx) ??
          ([
            {
              filename: "data_001.csv",
              contentType: "text/csv",
              category: "raw" as const,
            },
          ] satisfies SyntheticFileSpec[]);
        return specs.map((spec, fi) => {
          const status = seedFileStatus(runIdx, fi);
          return {
            instrumentRunId: run.id,
            relativePath: spec.filename,
            s3Bucket: RAW_BUCKET,
            s3Key: `${run.instrumentId}/${run.runId}/${spec.filename}`,
            filename: spec.filename,
            contentType: spec.contentType,
            sizeBytes: spec.sizeBytes ?? 1024 * (fi + 1),
            category: spec.category,
            status,
            metadata: { seeded: true },
            errorMessage:
              status === "failed" ? "Seeded failure for UI exercise" : null,
            uploadedAt: status === "failed" ? null : new Date(),
            processedAt: status === "completed" ? new Date() : null,
          };
        });
      });

  // Chunk large inserts (Hina can seed thousands of file rows per reseed).
  for (let i = 0; i < fileRows.length; i += FILE_INSERT_CHUNK) {
    await db
      .insert(schema.files)
      .values(fileRows.slice(i, i + FILE_INSERT_CHUNK));
  }

  // If the local-mirror env var is set and this instrument has a fixture,
  // copy the fixture bytes into
  // `<LOCAL_S3_MIRROR>/<RAW_BUCKET>/<instrumentId>/<runId>/<filename>`
  // for every run. The web app's local-mirror route then serves them
  // when the dashboard requests `/api/v1/files/<id>/download`.
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

export interface SeedCommentAuthor {
  id: string;
  name: string;
}

interface CommentThreadBeat {
  authorIndex: number;
  body: string;
  // Offset from "now" in hours (positive = in the past).
  hoursAgo: number;
}

// Curated multi-turn threads so run pages look like a real lab workspace
// rather than "Seeded comment N". Indices into the authors array passed to
// `seedRunComments` (0 = Alice / admin).
const COMMENT_THREADS: CommentThreadBeat[][] = [
  [
    {
      authorIndex: 1,
      body: "@Alice — does lane 3 look overexposed to you, or am I misreading the contrast?",
      hoursAgo: 5,
    },
    {
      authorIndex: 0,
      body: "A bit hot on the blue channel. Try re-exporting with auto-levels off and I'll take another look.",
      hoursAgo: 4.5,
    },
    {
      authorIndex: 1,
      body: "Re-exported — much cleaner. Leaving the original on the run for comparison.",
      hoursAgo: 3,
    },
  ],
  [
    {
      authorIndex: 2,
      body: "Quick note: standards were freshly diluted this morning (lot BCA-221).",
      hoursAgo: 8,
    },
    {
      authorIndex: 0,
      body: "Thanks @Carol — that matches the curve shape. Claiming this one.",
      hoursAgo: 7,
    },
  ],
  [
    {
      authorIndex: 3,
      body: "Cq values look consistent across tech replicates. Anyone else seeing the late amp in H12?",
      hoursAgo: 26,
    },
    {
      authorIndex: 4,
      body: "@Carol H12 was the NTC — expected. Everything else looks good to proceed.",
      hoursAgo: 25,
    },
  ],
  [
    {
      authorIndex: 5,
      body: "Plate map is in the notebook under 2026-07-14 / ELM Comp. Rows A–D are 1:5 dilutions.",
      hoursAgo: 30,
    },
  ],
  [
    {
      authorIndex: 6,
      body: "@Alice can we reprocess this? The preview PNG looks washed out compared to the TIFF.",
      hoursAgo: 12,
    },
    {
      authorIndex: 0,
      body: "Reprocessing now. If it still looks off, check the scanner DPI — 300 vs 600 changes the preview a lot.",
      hoursAgo: 11,
    },
    {
      authorIndex: 6,
      body: "Looks good after reprocess. Thanks!",
      hoursAgo: 10,
    },
  ],
  [
    {
      authorIndex: 7,
      body: "DIN for the gDNA ladder was within range. Moving these samples to library prep.",
      hoursAgo: 48,
    },
    {
      authorIndex: 8,
      body: "Noted — I'll pull the electropherogram into the QC sheet.",
      hoursAgo: 46,
    },
  ],
  [
    {
      authorIndex: 9,
      body: "Question: should we keep the failed upload row or dismiss it? Watcher retried successfully on the next heartbeat.",
      hoursAgo: 6,
    },
    {
      authorIndex: 0,
      body: "Dismiss the failed one — the completed sibling is the source of truth.",
      hoursAgo: 5.5,
    },
  ],
  [
    {
      authorIndex: 10,
      body: "Z-stack looks solid through planes 2–4. Plane 1 is a bit dim on FITC.",
      hoursAgo: 2,
    },
  ],
];

export async function seedRunComments(
  db: Db,
  runs: SeededRun[],
  authors: SeedCommentAuthor[]
): Promise<void> {
  if (runs.length === 0 || authors.length === 0) {
    return;
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekStartMs = new Date(startOfWeekISO(timeZone)).getTime();
  const lastWeekCommentAt = new Date(weekStartMs - 2 * DAY_MS);
  const now = Date.now();

  type CommentInsert = typeof schema.runComments.$inferInsert;
  const rows: CommentInsert[] = [];

  for (const [runIndex, run] of runs.entries()) {
    // Rich threads on every third run; everyone else gets a short note so
    // the comments column isn't empty in list views.
    if (runIndex % 3 === 0) {
      const thread = COMMENT_THREADS[runIndex % COMMENT_THREADS.length];
      for (const beat of thread) {
        const author = authors[beat.authorIndex % authors.length];
        rows.push({
          runId: run.id,
          userId: author.id,
          body: beat.body,
          createdAt: new Date(now - beat.hoursAgo * HOUR_MS),
        });
      }
      continue;
    }

    const author = authors[(runIndex + 1) % authors.length];
    rows.push({
      runId: run.id,
      userId: author.id,
      body:
        runIndex % 4 === 3
          ? `Checked ${run.runId} last week — looks consistent with the prior replicate.`
          : `Logged ${run.runId}. Samples stored in box ${String.fromCharCode(65 + (runIndex % 6))}-${(runIndex % 9) + 1}.`,
      createdAt: runIndex % 4 === 3 ? lastWeekCommentAt : new Date(),
    });
  }

  await db.insert(schema.runComments).values(rows);
}

export async function seedRunAttributions(
  db: Db,
  runs: SeededRun[],
  userIds: string[]
): Promise<void> {
  if (runs.length === 0 || userIds.length === 0) {
    return;
  }
  const rows = runs.map((run, i) => ({
    runId: run.id,
    userId: userIds[i % userIds.length],
  }));
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

// Fixed presets: first names A→Z, last names Z→A (Alice Zimmerman … Zoe
// Anderson). Alice is seeded separately as admin. Deterministic so
// screenshots / bug reports keep matching after a `db:reseed`.
const TEAMMATE_PRESETS: Omit<SeededTeammate, "id">[] = [
  { name: "Bob Young", email: "bob@example.com" },
  { name: "Carol Xu", email: "carol@example.com" },
  { name: "David Watson", email: "david@example.com" },
  { name: "Emma Vargas", email: "emma@example.com" },
  { name: "Frank Underwood", email: "frank@example.com" },
  { name: "Grace Torres", email: "grace@example.com" },
  { name: "Henry Sullivan", email: "henry@example.com" },
  { name: "Iris Rivera", email: "iris@example.com" },
  { name: "Jack Quigley", email: "jack@example.com" },
  { name: "Kate Parker", email: "kate@example.com" },
  { name: "Leo Owens", email: "leo@example.com" },
  { name: "Maria Nguyen", email: "maria@example.com" },
  { name: "Nina Mitchell", email: "nina@example.com" },
  { name: "Oscar Larson", email: "oscar@example.com" },
  { name: "Paula Keller", email: "paula@example.com" },
  { name: "Quinn Johnson", email: "quinn@example.com" },
  { name: "Rachel Ingram", email: "rachel@example.com" },
  { name: "Sam Hughes", email: "sam@example.com" },
  { name: "Tina Garcia", email: "tina@example.com" },
  { name: "Uma Foster", email: "uma@example.com" },
  { name: "Victor Edwards", email: "victor@example.com" },
  { name: "Wendy Dawson", email: "wendy@example.com" },
  { name: "Xavier Carter", email: "xavier@example.com" },
  { name: "Yara Benson", email: "yara@example.com" },
  { name: "Zoe Anderson", email: "zoe@example.com" },
];

export async function seedTeammates(
  db: Db,
  count = TEAMMATE_PRESETS.length
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
//     comment-on-your-run + follow-up pattern lands under the TODAY header.
//   - Yesterday bucket: three groups of `run_created` notifications (3 + 3
//     + 2 rows across three different instruments) so the grouped-row
//     variant of the popover renders with a comma-separated run-id list
//     under each instrument heading.
//   - Earlier bucket: one already-read `comment_participated` row so the
//     read-vs-unread visual contrast and the "Earlier" section both show
//     up after the first popover open.
//
// All notifications target a single recipient (the admin user). Comments
// authored by the teammates are inserted here as well so the popover can
// surface their body preview without depending on `seedRunComments`
// having already inserted teammate comments.
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
    "@Alice can you take a look at the OD readings on plate 3? Something looks off…",
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
  // left rail). The admin has seeded comments on many runs via
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
          ? `runs/${run.instrumentId}/${run.runId}/archive.zip`
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
