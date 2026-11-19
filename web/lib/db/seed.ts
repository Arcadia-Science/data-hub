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
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "better-auth/crypto";
import { eq, getTableName, isTable, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { SCOPE_PRESETS } from "@/lib/api/scope-catalog";
import { readSettingsFromYaml } from "@/lib/api/watcher-config/from-yaml";
import {
  canonicalSettings,
  type WatcherConfigSettings,
} from "@/lib/api/watcher-config/settings";
import { AUTO_UPDATE_STATUS_REASON } from "@/lib/api/watcher-status";
import {
  startOfLastWeekEndDayISO,
  startOfLastWeekISO,
  startOfMonthISO,
  startOfTodayISO,
  startOfWeekISO,
  startOfYesterdayISO,
} from "@/lib/date";
import { DEV_PASSWORD } from "@/lib/dev-auth";
import { parseNotebookLinkUrl } from "@/lib/notebook-links/url";
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

// The watcher version most seeded watchers run, and the seeded "latest
// version". It is at least 1.4.0, the first version that lets the web app edit
// a watcher's settings, so the edit form works on a local database. Keep it at
// the version in `watcher/pyproject.toml`. Integration tests keep the
// historical 9.9.9 default via `seedWatcherReleaseConfig`'s parameter default.
export const SEED_WATCHER_VERSION = "1.4.3";

// A few seeded watchers run an older version, so the "Update available" notice
// and the amber rollout pill have examples. One still supports editing from
// the web app; the other is older than 1.4.0, so its Settings tab asks for an
// update.
const BEHIND_WATCHER_VERSIONS: Readonly<Record<string, string>> = {
  "colony-counter-g": "1.4.0",
  "balance-f": "1.3.2",
};

function currentWatcherVersion(instrumentId: string): string {
  return BEHIND_WATCHER_VERSIONS[instrumentId] ?? SEED_WATCHER_VERSION;
}

// ---------------------------------------------------------------------------
// clearAll — schema-driven TRUNCATE of every `pgTable` declared in
// `lib/db/schema.ts` except `jwks`. Uses CASCADE so FK ordering doesn't
// matter; the previous static `TRUNCATE_ORDER` list was a maintenance hazard
// (every new table required a manual edit) and is replaced by this.
// ---------------------------------------------------------------------------

// The MCP route caches the published signing keys and rate-limits refetches,
// so a running server would reject tokens signed by a replacement key.
const KEPT_TABLES = new Set<string>([getTableName(schema.jwks)]);

export async function clearAll(db: Db): Promise<void> {
  // Cast through `unknown[]` so the `isTable` type predicate can narrow
  // away the `PgEnum`s and other non-table exports in the schema module
  // without TS complaining about cross-module generic identity on the
  // `PgTable<…>` types (which all structurally extend drizzle's `Table`
  // but TS won't accept the union as-is).
  const tableNames = (Object.values(schema) as unknown[])
    .filter(isTable)
    .map((t) => getTableName(t))
    .filter((name) => !KEPT_TABLES.has(name));

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
  // Name of the minted PAT, shown wherever the token is named as an actor.
  tokenName?: string;
}

export interface SeedUserResult {
  email: string;
  token: string;
  // PAT row id — used by watcher-binding tests that assert
  // `watchers.registered_by_token` matches the registering credential.
  tokenId: string;
  userId: string;
}

async function seedCredentialAccount(db: Db, userId: string): Promise<void> {
  // Better Auth stores passwords on a `credential` account row, not the
  // user. Shared `DEV_PASSWORD` lets the "Sign in (dev)" form submit an
  // invisible password for any seeded email.
  await db.insert(schema.accounts).values({
    id: crypto.randomUUID(),
    userId,
    accountId: userId,
    providerId: "credential",
    password: await hashPassword(DEV_PASSWORD),
  });
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
    emailVerified: true,
    isAdmin: options.isAdmin ?? false,
  });
  await seedCredentialAccount(db, userId);

  const plaintext = generateToken();
  const [pat] = await db
    .insert(schema.personalAccessTokens)
    .values({
      createdBy: userId,
      name: options.tokenName ?? "seeded-token",
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

// The MCP audience row that `resources` in `lib/auth.ts` declares. Better Auth
// inserts it only once per server process, so a server that outlives a reset
// rejects every MCP token request with `invalid_target` until this restores it.
export async function seedMcpResource(db: Db, origin: string): Promise<void> {
  const identifier = `${origin}/mcp/v1`;
  const now = new Date();
  await db
    .insert(schema.oauthResources)
    .values({
      id: crypto.randomUUID(),
      identifier,
      name: identifier,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: schema.oauthResources.identifier });
}

// ---------------------------------------------------------------------------
// Instruments — mirrors the production catalog (ids + display names) so docs
// screenshots look real, plus one pending instrument for the activate-
// instrument admin UI. `azure-cielo-qpcr` stays typed as `qpcr` locally so
// fixture processing still runs even though prod currently marks it generic.
// ---------------------------------------------------------------------------

// The state of an instrument's current watcher when the seed runs. The
// watcher's heartbeats and events are built to match (see seedWatchers).
export type SeededWatcherStatus =
  // Connected, no heartbeat yet (the pending instrument).
  | "registered"
  // Checking in every few minutes.
  | "watching"
  // Running, but its watch folder is missing.
  | "waiting"
  // Stopped by someone, so no heartbeat since then.
  | "stopped"
  // Stopped for an automatic update a few minutes before the seed runs.
  | "restarting"
  // Watching when last seen, and silent since.
  | "unresponsive"
  // No current watcher: the instrument never had one, or only deregistered ones.
  | "none";

// A watcher that was deregistered from an instrument. The day counts are
// counted back from the moment the seed runs.
export interface SeededPastWatcher {
  deregisteredDaysAgo: number;
  hostname: string;
  osInfo: string;
  registeredDaysAgo: number;
}

// The made-up instruments' runs are this much older than the catalog's runs.
const MADE_UP_RUNS_OLDER_BY_DAYS = 2;

export interface SeededRunPlan {
  // Every run comes from the processing Lambda, none from a watcher.
  lambdaOnly?: boolean;
  // Moves every run's acquisition time back by this many days.
  olderByDays?: number;
}

export interface SeededInstrument {
  // Watcher config YAML snapped from production, with `{{WATCHER_ID}}`
  // substituted at seed time so the Configuration tab shows a real
  // instrument block (watch dir, patterns, run detection) instead of a
  // placeholder comment. Only for instruments that have had a watcher.
  configYamlTemplate?: string;
  displayName: string;
  hostname?: string;
  id: string;
  instrumentType: schema.InstrumentType;
  osInfo?: string;
  // Watchers deregistered from this instrument, oldest first.
  pastWatchers?: SeededPastWatcher[];
  // How seedRuns places this instrument's runs. The made-up instruments set it
  // so their runs are older than the catalog's newest runs and don't take over
  // the dashboard's most recently active instruments.
  runPlan?: SeededRunPlan;
  status: "pending" | "active" | "inactive";
  // Upload mode in the watcher config and in its heartbeats. Defaults to auto.
  uploadMode?: "auto" | "manual";
  watcherStatus: SeededWatcherStatus;
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
    instrumentType: "aunty",
    status: "active",
    hostname: "Aunty-1075",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    pastWatchers: [
      {
        deregisteredDaysAgo: 12,
        hostname: "LAB-PC-02",
        osInfo: "Windows 11",
        registeredDaysAgo: 40,
      },
    ],
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
    hostname: "LAB-PC-03",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: azure-600-gel-doc
  watch_directory: C:\\Data
  file_patterns:
  - '*.tif'
  - '*.jpg'
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
    hostname: "LAB-PC-03",
    osInfo: "Windows 11",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: epson-v700-scanner
  watch_directory: C:\\Users\\LabUser\\ScanData
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
    // Stays generic until an operator confirms PDFs match the ÄKTA `fplc`
    // processor; typing it `fplc` without that check would mis-route files.
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
  // The made-up instruments below cover the watcher states that the instruments
  // above do not. Their names and hostnames are invented.
  {
    id: "microplate-washer-d",
    runPlan: { olderByDays: MADE_UP_RUNS_OLDER_BY_DAYS },
    displayName: "Microplate Washer D",
    instrumentType: "generic",
    status: "active",
    hostname: "LAB-PC-01",
    osInfo: "Windows 11",
    // Shares a computer with Shaker Incubator E. Its hostname is upper case,
    // and the other one is lower case.
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: microplate-washer-d
  watch_directory: C:\\Data\\MicroplateWasherD
  file_patterns:
  - '*.csv'
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
    id: "shaker-incubator-e",
    runPlan: { olderByDays: MADE_UP_RUNS_OLDER_BY_DAYS },
    displayName: "Shaker Incubator E",
    instrumentType: "generic",
    status: "active",
    hostname: "lab-pc-01",
    osInfo: "Windows 11",
    // Upload mode is manual: each file waits for someone to approve it.
    uploadMode: "manual",
    watcherStatus: "watching",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: shaker-incubator-e
  watch_directory: C:\\Data\\ShakerIncubatorE
  file_patterns:
  - '*.csv'
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
    id: "balance-f",
    runPlan: { olderByDays: MADE_UP_RUNS_OLDER_BY_DAYS },
    displayName: "Balance F",
    instrumentType: "generic",
    status: "active",
    hostname: "LAB-PC-04",
    osInfo: "Windows 10",
    // Last seen two hours before the seed runs, so it reads as Unresponsive.
    watcherStatus: "unresponsive",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: balance-f
  watch_directory: C:\\Data\\BalanceF
  file_patterns:
  - '*.csv'
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
    id: "colony-counter-g",
    runPlan: { olderByDays: MADE_UP_RUNS_OLDER_BY_DAYS },
    displayName: "Colony Counter G",
    instrumentType: "generic",
    status: "active",
    hostname: "LAB-PC-05",
    osInfo: "Windows 11",
    // Running, but its watch folder is missing.
    watcherStatus: "waiting",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: colony-counter-g
  watch_directory: D:\\Colony Counter Images
  file_patterns:
  - '*.tif'
  - '*.png'
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
    id: "thermal-mixer-h",
    runPlan: { olderByDays: MADE_UP_RUNS_OLDER_BY_DAYS },
    displayName: "Thermal Mixer H",
    instrumentType: "generic",
    status: "active",
    hostname: "LAB-PC-06",
    osInfo: "Windows 11",
    // Stopped for an automatic update a few minutes before the seed runs.
    watcherStatus: "restarting",
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: thermal-mixer-h
  watch_directory: C:\\Data\\ThermalMixerH
  file_patterns:
  - '*.csv'
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
    id: "spectrophotometer-b",
    runPlan: { olderByDays: MADE_UP_RUNS_OLDER_BY_DAYS },
    displayName: "Spectrophotometer B",
    instrumentType: "generic",
    status: "active",
    // Its only watcher was deregistered, so there is no current one.
    watcherStatus: "none",
    pastWatchers: [
      {
        deregisteredDaysAgo: 9,
        hostname: "LAB-PC-03",
        osInfo: "Windows 10",
        registeredDaysAgo: 30,
      },
    ],
    configYamlTemplate: buildSeedConfigYaml(`instrument:
  id: spectrophotometer-b
  watch_directory: C:\\Data\\SpectrophotometerB
  file_patterns:
  - '*.csv'
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
    id: "centrifuge-c",
    runPlan: { lambdaOnly: true, olderByDays: MADE_UP_RUNS_OLDER_BY_DAYS },
    displayName: "Centrifuge C",
    instrumentType: "generic",
    status: "active",
    // Never had a watcher.
    watcherStatus: "none",
  },
];

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
  status: "registered" | "watching" | "stopped" | "waiting";
}

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;
const HISTORY_DAYS = 7;
// Rows per insert, so a week of heartbeats stays well under the bind-parameter
// limit and the seed stays quick.
const WATCHER_ROW_CHUNK = 1000;

// The start of the reason a watcher gives while its watch folder is missing.
// The watcher follows it with a colon and the folder's path
// (`WATCH_DIRECTORY_NOT_FOUND` in watcher/src/data_hub_watcher/models.py).
const WATCH_DIRECTORY_NOT_FOUND = "watch_directory not found";
// Stopped by someone, two days before the seed runs.
const STOPPED_BY_USER_MINUTES_AGO = 2 * MINUTES_PER_DAY;
// Stopped for an automatic update four minutes before the seed runs. It reads
// as Restarting until 15 minutes after that stop, then as Unresponsive.
const RESTARTING_STOP_MINUTES_AGO = 4;
const RESTARTING_FROM_VERSION = "0.9.4";
// Unresponsive: last heard from two hours before the seed runs.
const UNRESPONSIVE_LAST_SEEN_MINUTES_AGO = 2 * 60;
// Minutes into a day when the seeded uploads and run reports happen.
const UPLOAD_MINUTES_OF_DAY = [180, 540, 960] as const;
const RUN_REPORT_MINUTE_OF_DAY = 420;

// Watchers with a week of history. `seedWatcherHistory` writes their heartbeats
// (one every `stepMinutes`), uploads, run reports, restarts and gaps.
interface WatcherHistoryPlan {
  failedUploadMinutesAgo?: number;
  // Gaps with no heartbeat, each ended by a heartbeat_recovered error at
  // `recoveredMinutesAgo`, after `missedHeartbeats` heartbeats that never came.
  recoveries: { missedHeartbeats: number; recoveredMinutesAgo: number }[];
  // Automatic-update restarts, oldest first. The watcher stops
  // `stoppedMinutesAgo` before the seed runs and is back `gapMinutes` later.
  restarts: {
    from: string;
    gapMinutes: number;
    stoppedMinutesAgo: number;
    to: string;
  }[];
  // Heartbeat cadence, in minutes.
  stepMinutes: number;
  // Files uploaded each day, one to three.
  uploadsPerDay: number;
}

const WATCHER_HISTORY: Partial<Record<string, WatcherHistoryPlan>> = {
  // One heartbeat every minute, with three restarts that climb to the current
  // version and one missed-heartbeat gap.
  "jolene-fplc": {
    stepMinutes: 1,
    uploadsPerDay: 3,
    restarts: [
      { stoppedMinutesAgo: 8880, gapMinutes: 3, from: "0.9.2", to: "0.9.3" },
      { stoppedMinutesAgo: 5100, gapMinutes: 3, from: "0.9.3", to: "0.9.4" },
      {
        stoppedMinutesAgo: 1500,
        gapMinutes: 4,
        from: "0.9.4",
        to: SEED_WATCHER_VERSION,
      },
    ],
    recoveries: [{ recoveredMinutesAgo: 6480, missedHeartbeats: 3 }],
  },
  // One heartbeat every five minutes, one missed heartbeat, and one failed upload.
  "spectramax-id3-plate-reader": {
    stepMinutes: 5,
    uploadsPerDay: 2,
    restarts: [],
    recoveries: [{ recoveredMinutesAgo: 3120, missedHeartbeats: 1 }],
    failedUploadMinutesAgo: 1800,
  },
  // One heartbeat every five minutes, with a longer gap.
  "agilent-4150-tapestation": {
    stepMinutes: 5,
    uploadsPerDay: 2,
    restarts: [],
    recoveries: [{ recoveredMinutesAgo: 7200, missedHeartbeats: 2 }],
  },
};

type WatcherHeartbeatRow = typeof schema.watcherHeartbeats.$inferInsert;
type WatcherEventRow = typeof schema.watcherEvents.$inferInsert;
type WatcherConfigRevisionRow =
  typeof schema.watcherConfigRevisions.$inferInsert;

function minutesBefore(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * MINUTE_MS);
}

function heartbeatRow(
  watcherId: string,
  timestamp: Date,
  status: string,
  uploadMode: "auto" | "manual",
  uptimeSeconds: number,
  filesUploadedSinceLast = 0,
  runsReportedSinceLast = 0
): WatcherHeartbeatRow {
  return {
    watcherId,
    timestamp,
    status,
    uploadMode,
    filesUploadedSinceLast,
    runsReportedSinceLast,
    errorsSinceLast: 0,
    uptimeSeconds,
  };
}

function eventRow(
  watcherId: string,
  eventType: WatcherEventRow["eventType"],
  message: string,
  timestamp: Date,
  details: Record<string, unknown> = {}
): WatcherEventRow {
  return { watcherId, eventType, message, details, timestamp };
}

// Ten heartbeats five minutes apart. The first is `fromMinutesAgo` before the
// seed runs and the rest are older. `startedMinutesAgo` is when the watcher's
// current run began, which sets the uptime.
function tenHeartbeats(
  watcherId: string,
  now: Date,
  uploadMode: "auto" | "manual",
  fromMinutesAgo: number,
  startedMinutesAgo: number,
  statusAt: (index: number) => string
): WatcherHeartbeatRow[] {
  return Array.from({ length: 10 }, (_, index) => {
    const minutesAgo = fromMinutesAgo + index * 5;
    const status = statusAt(index);
    // Only a watching watcher reports uploads, and the first heartbeat reports
    // none.
    const uploads = status === "watching" && index > 0 ? 1 : 0;
    return heartbeatRow(
      watcherId,
      minutesBefore(now, minutesAgo),
      status,
      uploadMode,
      (startedMinutesAgo - minutesAgo) * 60,
      uploads
    );
  });
}

function fileUploadedEvent(
  watcherId: string,
  timestamp: Date,
  instrumentId: string,
  runId: string,
  filename: string,
  sizeBytes: number
): WatcherEventRow {
  const s3Key = `${instrumentId}/${runId}/${filename}`;
  return eventRow(
    watcherId,
    "file_uploaded",
    `Uploaded ${filename}`,
    timestamp,
    {
      s3_key: s3Key,
      sha256: createHash("sha256").update(s3Key).digest("hex"),
      size_bytes: sizeBytes,
    }
  );
}

function appliedEvent(
  watcherId: string,
  revision: number,
  timestamp: Date
): WatcherEventRow {
  return eventRow(
    watcherId,
    "config_synced",
    `Applied config revision ${revision}`,
    timestamp,
    { kind: "config_revision_applied", revision }
  );
}

function rejectedEvent(
  watcherId: string,
  revision: number,
  reason: string,
  timestamp: Date
): WatcherEventRow {
  return eventRow(
    watcherId,
    "error",
    `Rejected config revision ${revision}: ${reason}`,
    timestamp,
    { kind: "config_revision_rejected", revision, reason }
  );
}

function revisionRow(
  watcherId: string,
  revision: number,
  source: "web" | "pc",
  status: "pending" | "applied" | "rejected",
  settings: WatcherConfigSettings,
  when: {
    createdAt: Date;
    createdBy?: string;
    resolvedAt?: Date;
    statusReason?: string;
  }
): WatcherConfigRevisionRow {
  return {
    watcherId,
    revision,
    source,
    status,
    settings: canonicalSettings(settings),
    statusReason: when.statusReason ?? null,
    createdBy: when.createdBy ?? null,
    createdAt: when.createdAt,
    resolvedAt: when.resolvedAt ?? null,
  };
}

function templateOf(instrument: SeededInstrument): string {
  const { configYamlTemplate } = instrument;
  if (!configYamlTemplate) {
    throw new Error(`${instrument.id} has no watcher config to seed`);
  }
  return configYamlTemplate;
}

// The hostname and OS a current watcher reports, and its config template.
function watcherIdentity(instrument: SeededInstrument): {
  configYamlTemplate: string;
  hostname: string;
  osInfo: string;
} {
  const { hostname, osInfo } = instrument;
  if (!(hostname && osInfo)) {
    throw new Error(`${instrument.id} has a watcher but no hostname or OS`);
  }
  return { configYamlTemplate: templateOf(instrument), hostname, osInfo };
}

function watchDirectoryOf(template: string): string {
  const match = /^ {2}watch_directory: (.+)$/m.exec(template);
  if (!match?.[1]) {
    throw new Error("A seeded watcher config has no watch_directory");
  }
  return match[1];
}

// The editable settings a seeded config holds, read the way the server reads
// a pushed config.yaml, so the revisions match what the watcher reports.
function settingsFromTemplate(template: string): WatcherConfigSettings {
  const result = readSettingsFromYaml(
    template.replaceAll("{{WATCHER_ID}}", "seed-watcher")
  );
  if (!result.ok) {
    throw new Error(`A seeded watcher config is not valid: ${result.reason}`);
  }
  return result.settings;
}

// What seedWatchers writes for one active watcher. Watchers in WATCHER_HISTORY
// get their heartbeats and events later, from seedWatcherScenarios.
interface WatcherRows {
  createdAt: Date;
  events: WatcherEventRow[];
  heartbeats: WatcherHeartbeatRow[];
  lastHeartbeatAt: Date | null;
  status: "registered" | "watching" | "waiting" | "stopped";
  statusReason: string | null;
}

function watcherCreatedAt(instrument: SeededInstrument, now: Date): Date {
  if (WATCHER_HISTORY[instrument.id]) {
    return minutesBefore(now, HISTORY_DAYS * MINUTES_PER_DAY);
  }
  const pastWatchers = instrument.pastWatchers ?? [];
  const lastPast = pastWatchers.at(-1);
  return lastPast
    ? minutesBefore(now, lastPast.deregisteredDaysAgo * MINUTES_PER_DAY)
    : now;
}

function currentWatcherRows(
  instrument: SeededInstrument,
  watcherId: string,
  now: Date
): WatcherRows {
  const uploadMode = instrument.uploadMode ?? "auto";
  const createdAt = watcherCreatedAt(instrument, now);
  switch (instrument.watcherStatus) {
    case "registered":
      return {
        createdAt,
        status: "registered",
        statusReason: null,
        lastHeartbeatAt: null,
        heartbeats: [],
        events: [],
      };
    case "watching": {
      if (WATCHER_HISTORY[instrument.id]) {
        return {
          createdAt,
          status: "watching",
          statusReason: null,
          lastHeartbeatAt: now,
          heartbeats: [],
          events: [],
        };
      }
      return {
        createdAt,
        status: "watching",
        statusReason: null,
        lastHeartbeatAt: now,
        heartbeats: tenHeartbeats(
          watcherId,
          now,
          uploadMode,
          0,
          60,
          () => "watching"
        ),
        events: [
          eventRow(
            watcherId,
            "watcher_started",
            "Watcher started",
            minutesBefore(now, 60)
          ),
          eventRow(
            watcherId,
            "config_synced",
            "Config synced from server",
            minutesBefore(now, 50)
          ),
          eventRow(
            watcherId,
            "file_uploaded",
            "Uploaded latest run files to S3",
            minutesBefore(now, 10)
          ),
        ],
      };
    }
    case "waiting": {
      const watchDirectory = watchDirectoryOf(templateOf(instrument));
      const reason = `${WATCH_DIRECTORY_NOT_FOUND}: ${watchDirectory}`;
      return {
        createdAt,
        status: "waiting",
        statusReason: reason,
        lastHeartbeatAt: now,
        heartbeats: tenHeartbeats(
          watcherId,
          now,
          uploadMode,
          0,
          60,
          () => "waiting"
        ),
        events: [
          eventRow(
            watcherId,
            "watcher_started",
            "Watcher started",
            minutesBefore(now, 60)
          ),
          eventRow(
            watcherId,
            "config_synced",
            "Config synced from server",
            minutesBefore(now, 59)
          ),
          eventRow(
            watcherId,
            "error",
            `Waiting: ${reason}`,
            minutesBefore(now, 55),
            {
              kind: "watch_directory_unavailable",
              watch_directory: watchDirectory,
              reason,
            }
          ),
        ],
      };
    }
    case "stopped":
      return {
        createdAt,
        status: "stopped",
        statusReason: null,
        lastHeartbeatAt: minutesBefore(now, STOPPED_BY_USER_MINUTES_AGO),
        heartbeats: tenHeartbeats(
          watcherId,
          now,
          uploadMode,
          STOPPED_BY_USER_MINUTES_AGO,
          STOPPED_BY_USER_MINUTES_AGO + 60,
          (index) => (index === 0 ? "stopped" : "watching")
        ),
        events: [
          eventRow(
            watcherId,
            "watcher_started",
            "Watcher started",
            minutesBefore(now, STOPPED_BY_USER_MINUTES_AGO + 60)
          ),
          eventRow(
            watcherId,
            "config_synced",
            "Config synced from server",
            minutesBefore(now, STOPPED_BY_USER_MINUTES_AGO + 50)
          ),
          eventRow(
            watcherId,
            "file_uploaded",
            "Uploaded latest run files to S3",
            minutesBefore(now, STOPPED_BY_USER_MINUTES_AGO + 10)
          ),
          eventRow(
            watcherId,
            "watcher_stopped",
            "Service stopped",
            minutesBefore(now, STOPPED_BY_USER_MINUTES_AGO)
          ),
        ],
      };
    case "restarting":
      return {
        createdAt,
        status: "stopped",
        statusReason: AUTO_UPDATE_STATUS_REASON,
        lastHeartbeatAt: minutesBefore(now, RESTARTING_STOP_MINUTES_AGO),
        heartbeats: tenHeartbeats(
          watcherId,
          now,
          uploadMode,
          RESTARTING_STOP_MINUTES_AGO,
          190,
          (index) => (index === 0 ? "stopped" : "watching")
        ),
        events: [
          eventRow(
            watcherId,
            "watcher_started",
            "Watcher started",
            minutesBefore(now, 190)
          ),
          eventRow(
            watcherId,
            "config_synced",
            "Config synced from server",
            minutesBefore(now, 189)
          ),
          eventRow(
            watcherId,
            "file_uploaded",
            "Uploaded latest run files to S3",
            minutesBefore(now, 40)
          ),
          eventRow(
            watcherId,
            "update_started",
            `Upgrading watcher ${RESTARTING_FROM_VERSION} -> ${SEED_WATCHER_VERSION}`,
            minutesBefore(now, RESTARTING_STOP_MINUTES_AGO + 2),
            {
              current_version: RESTARTING_FROM_VERSION,
              target_version: SEED_WATCHER_VERSION,
              mandatory: false,
              install_method: "uv-tool",
            }
          ),
          eventRow(
            watcherId,
            "watcher_stopped",
            "Service restarting for auto-update",
            minutesBefore(now, RESTARTING_STOP_MINUTES_AGO)
          ),
        ],
      };
    case "unresponsive":
      return {
        createdAt,
        status: "watching",
        statusReason: null,
        lastHeartbeatAt: minutesBefore(now, UNRESPONSIVE_LAST_SEEN_MINUTES_AGO),
        heartbeats: tenHeartbeats(
          watcherId,
          now,
          uploadMode,
          UNRESPONSIVE_LAST_SEEN_MINUTES_AGO,
          UNRESPONSIVE_LAST_SEEN_MINUTES_AGO + 60,
          () => "watching"
        ),
        events: [
          eventRow(
            watcherId,
            "watcher_started",
            "Watcher started",
            minutesBefore(now, UNRESPONSIVE_LAST_SEEN_MINUTES_AGO + 60)
          ),
          eventRow(
            watcherId,
            "config_synced",
            "Config synced from server",
            minutesBefore(now, UNRESPONSIVE_LAST_SEEN_MINUTES_AGO + 59)
          ),
          eventRow(
            watcherId,
            "file_uploaded",
            "Uploaded latest run files to S3",
            minutesBefore(now, UNRESPONSIVE_LAST_SEEN_MINUTES_AGO + 5)
          ),
        ],
      };
    case "none":
      throw new Error(`${instrument.id} has no current watcher to seed`);
    default:
      return instrument.watcherStatus satisfies never;
  }
}

async function insertHeartbeatRows(
  db: Db,
  rows: WatcherHeartbeatRow[]
): Promise<void> {
  for (let i = 0; i < rows.length; i += WATCHER_ROW_CHUNK) {
    await db
      .insert(schema.watcherHeartbeats)
      .values(rows.slice(i, i + WATCHER_ROW_CHUNK));
  }
}

async function insertEventRows(db: Db, rows: WatcherEventRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += WATCHER_ROW_CHUNK) {
    await db
      .insert(schema.watcherEvents)
      .values(rows.slice(i, i + WATCHER_ROW_CHUNK));
  }
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
  // state the real system can't produce. An instrument with no current watcher
  // (`none`) gets none here.
  const eligible = instruments.filter(
    (i) =>
      (i.status === "active" || i.status === "pending") &&
      i.watcherStatus !== "none"
  );
  if (eligible.length === 0) {
    return [];
  }

  const now = new Date();
  const plans = eligible.map((instrument) => {
    const id = crypto.randomUUID();
    const identity = watcherIdentity(instrument);
    const { configYaml, configChecksum } = renderWatcherConfig(
      identity.configYamlTemplate,
      id
    );
    const rows = currentWatcherRows(instrument, id, now);
    return {
      watcher: {
        id,
        instrumentId: instrument.id,
        hostname: identity.hostname,
        osInfo: identity.osInfo,
        watcherVersion: currentWatcherVersion(instrument.id),
        configChecksum,
        configYaml,
        createdAt: rows.createdAt,
        lastHeartbeatAt: rows.lastHeartbeatAt,
        status: rows.status,
        statusReason: rows.statusReason,
      },
      heartbeats: rows.heartbeats,
      events: rows.events,
    };
  });

  const inserted = await db
    .insert(schema.watchers)
    .values(plans.map((plan) => plan.watcher))
    .returning({
      id: schema.watchers.id,
      instrumentId: schema.watchers.instrumentId,
      status: schema.watchers.status,
    });

  await insertHeartbeatRows(
    db,
    plans.flatMap((plan) => plan.heartbeats)
  );
  await insertEventRows(
    db,
    plans.flatMap((plan) => plan.events)
  );

  return inserted;
}

// ---------------------------------------------------------------------------
// Runs + files — keys live under `RAW_BUCKET` so the lambda CLI's
// `--raw-bucket` default and any `LOCAL_S3_MIRROR` directory layout
// match. When `LOCAL_S3_MIRROR` is set in dev, `seedRuns` also copies
// fixtures from `lambda/tests/fixtures/` for instruments listed in
// `INSTRUMENT_FIXTURES` (cycling every listed file across runs) so
// seeded runs render real bytes in the dashboard out of the box.
// Other instruments get realistic filenames (no bytes) patterned
// after production.
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
      // Channel label is seed-prefixed so basenames never match prod nd2 names.
      filename: `Well${well}_Point${well}_${pointIdx}_ChannelSEED_BF,SEED_FITC,SEED_TRITC_Seq${seq}.nd2`,
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
  // Prefix keeps the prod well-site shape without colliding with real
  // InstantRaman basenames like `H10-Site_0.csv`.
  const wells = ["A01", "B05", "C10", "D03", "E08", "F12", "G02", "H10"];
  const files: SyntheticFileSpec[] = [];
  for (let i = 0; i < siteCount; i++) {
    const well = wells[i % wells.length];
    const site = Math.floor(i / wells.length);
    files.push(
      {
        filename: `SYN-${well}-Site_${site}.csv`,
        contentType: "text/csv",
        category: "raw",
        sizeBytes: 93_000,
      },
      {
        filename: `SYN-${well}-Site_${site}.json`,
        contentType: "application/json",
        category: "raw",
        sizeBytes: 4300,
      }
    );
  }
  return files;
}

export interface FixtureFileSpec {
  contentType: string;
  filename: string;
}

export interface InstrumentFixture {
  // When true, every run gets every file. Use for complementary
  // exports that belong on the same experiment (Cq Values + melt).
  // Default is to cycle `files` across runs, one fixture each.
  attachAll?: boolean;
  // Every available lambda fixture for this instrument; `seedRuns`
  // cycles them across the instrument's seeded runs so docs screenshots
  // cover each measurement / imaging mode, not just one example file.
  files: readonly FixtureFileSpec[];
  runIds: readonly string[];
}

const SPECTRAMAX_FIXTURE_FILES: readonly FixtureFileSpec[] = [
  {
    filename: "spectramax_plate_reader_endpoint.xls",
    contentType: "application/vnd.ms-excel",
  },
  {
    filename: "spectramax_plate_reader_endpoint_flat.xls",
    contentType: "application/vnd.ms-excel",
  },
  {
    filename: "spectramax_plate_reader_endpoint_sparse.xls",
    contentType: "application/vnd.ms-excel",
  },
  {
    filename: "spectramax_plate_reader_fluorescence.xls",
    contentType: "application/vnd.ms-excel",
  },
  {
    filename: "spectramax_plate_reader_kinetic.xls",
    contentType: "application/vnd.ms-excel",
  },
  {
    filename: "spectramax_plate_reader_well_scan.xls",
    contentType: "application/vnd.ms-excel",
  },
];

const SPECTRAMAX_SPECTRUM_96: FixtureFileSpec = {
  filename: "spectramax_plate_reader_spectrum.xls",
  contentType: "application/vnd.ms-excel",
};

const SPECTRAMAX_SPECTRUM_384: FixtureFileSpec = {
  filename: "spectramax_plate_reader_spectrum_384.xls",
  contentType: "application/vnd.ms-excel",
};

const SPECTRAMAX_LUMINESCENCE: FixtureFileSpec = {
  filename: "spectramax_plate_reader_luminescence.xls",
  contentType: "application/vnd.ms-excel",
};

const GEL_DOC_FIXTURE_FILES: readonly FixtureFileSpec[] = [
  {
    filename: "azure_600_gel_doc_example.tif",
    contentType: "image/tiff",
  },
  {
    filename: "azure_600_gel_doc_fluorescence.tif",
    contentType: "image/tiff",
  },
  {
    filename: "azure_600_gel_doc_true_color.tif",
    contentType: "image/tiff",
  },
];

// Keyed by instrument id (not type) so both SpectraMax readers can share
// the same fixture set under distinct ids / run-id lists.
export const INSTRUMENT_FIXTURES: Record<string, InstrumentFixture> = {
  "azure-cielo-qpcr": {
    attachAll: true,
    files: [
      {
        filename: "azure_cielo_qpcr_example.csv",
        contentType: "text/csv",
      },
      {
        filename: "azure_cielo_qpcr_MeltingCurve.csv",
        contentType: "text/csv",
      },
      // Vendor report PDF; the run page serves the raw bytes.
      {
        filename: "azure_cielo_qpcr_Report.pdf",
        contentType: "application/pdf",
      },
    ],
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
    files: GEL_DOC_FIXTURE_FILES,
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
    files: [
      ...SPECTRAMAX_FIXTURE_FILES,
      SPECTRAMAX_SPECTRUM_384,
      SPECTRAMAX_LUMINESCENCE,
    ],
    // Names track the cycled fixture order (endpoint → flat → sparse →
    // fluorescence → kinetic → well-scan → spectrum → luminescence).
    runIds: [
      "012926_AR_OD750",
      "012226_DK_OD595_flat",
      "011526_AR_OD600_sparse",
      "010826_DK_GFP_fluo",
      "010126_AR_OD595_kinetic",
      "122525_DK_OD595_wellscan",
      "121825_AR_FP_spectrum",
      "121125_DK_lum_endpoint",
    ],
  },
  "spectramax-id5-plate-reader": {
    files: [
      ...SPECTRAMAX_FIXTURE_FILES,
      SPECTRAMAX_SPECTRUM_96,
      SPECTRAMAX_LUMINESCENCE,
    ],
    // Same fixture cycle as iD3; stems stay distinct per reader.
    runIds: [
      "260721_OD750_AAA",
      "260720_OD595_flat_BBB",
      "260716_OD600_sparse_CCC",
      "260714_GFP_fluo_DDD",
      "260710_OD595_kinetic_EEE",
      "260705_OD595_wellscan_FFF",
      "260628_FP_spectrum_GGG",
      "260620_lum_endpoint_HHH",
    ],
  },
  "unchained-labs-aunty": {
    files: [
      {
        filename: "aunty_thermal_ramp.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        filename: "aunty_sizing.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        filename: "aunty_isothermal.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        filename: "aunty_table_only.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
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
    // Fully synthetic stems (not redacted prod initials like RAF→AAA).
    runIds: [
      "20260801_SYN_colony_300dpi_003",
      "20260801_SYN_colony_300dpi_002",
      "20260801_SYN_colony_300dpi_001",
      "20260728_SYN_ref_grid_300dpi_003",
      "20260722_SYN_kinetic_endpoint_300dpi_002",
      "20260718_SYN_replica_plate1_300dpi001",
      "20260718_SYN_replica_plate2_600dpi001",
      "20260712_SYN_colony_screen_300dpi001",
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
  count = 8,
  plan: SeededRunPlan = {}
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
    const acquiredAt = new Date(
      (schedule[i] ?? new Date(Date.now() - (i + 1) * 3 * DAY_MS)).getTime() -
        (plan.olderByDays ?? 0) * DAY_MS
    );
    const runId = runIds?.[i] ?? `run-${i + 1}`;
    const extraMeta = synthetic?.metadataForRun?.(runId, i) ?? {};
    return {
      instrumentId,
      runId,
      source: (plan.lambdaOnly || i % 2 === 0 ? "lambda" : "watcher") as
        | "lambda"
        | "watcher",
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

  const fixtureForRun = (runIdx: number): FixtureFileSpec[] => {
    if (!fixture || fixture.files.length === 0) {
      return [];
    }
    if (fixture.attachAll) {
      return [...fixture.files];
    }
    return [fixture.files[runIdx % fixture.files.length]];
  };

  // Cache fixture sizes once so multi-run seeds don't re-stat the same file.
  const fixtureSizeByName = new Map<string, number>();
  if (fixture) {
    await Promise.all(
      fixture.files.map(async (file) => {
        const { size } = await stat(path.resolve(FIXTURES_DIR, file.filename));
        fixtureSizeByName.set(file.filename, size);
      })
    );
  }

  const fileRows = fixture
    ? runs.flatMap((run, runIdx) => {
        const files = fixtureForRun(runIdx);
        if (files.length === 0) {
          throw new Error(
            `INSTRUMENT_FIXTURES[${instrumentId}] has no fixture files`
          );
        }
        return files.map((file, fileIdx) => {
          const status = seedFileStatus(runIdx, fileIdx);
          return {
            instrumentRunId: run.id,
            relativePath: file.filename,
            s3Bucket: RAW_BUCKET,
            s3Key: `${run.instrumentId}/${run.runId}/${file.filename}`,
            filename: file.filename,
            contentType: file.contentType,
            sizeBytes: fixtureSizeByName.get(file.filename) ?? 1024,
            category: "raw" as const,
            status,
            metadata: { seeded: true },
            errorMessage:
              status === "failed" ? "Seeded failure for UI exercise" : null,
            uploadedAt: status === "failed" ? null : new Date(),
            processedAt: status === "completed" ? new Date() : null,
          };
        });
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

  // If the local-mirror env var is set and this instrument has fixtures,
  // copy each run's fixture bytes into
  // `<LOCAL_S3_MIRROR>/<RAW_BUCKET>/<instrumentId>/<runId>/<filename>`.
  // The web app's local-mirror route then serves them when the dashboard
  // requests `/api/v1/files/<id>/download`.
  const mirrorRoot = process.env.LOCAL_S3_MIRROR;
  if (mirrorRoot && fixture) {
    await Promise.all(
      runs.flatMap((run, runIdx) =>
        fixtureForRun(runIdx).map(async (file) => {
          const src = path.resolve(FIXTURES_DIR, file.filename);
          const dest = path.resolve(
            mirrorRoot,
            RAW_BUCKET,
            run.instrumentId,
            run.runId,
            file.filename
          );
          await mkdir(path.dirname(dest), { recursive: true });
          await copyFile(src, dest);
        })
      )
    );
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Watcher scenarios: a week of history, past watchers, config changes, runs
// with files waiting for upload, and the token a pending instrument's watcher
// registered with. They run after the runs and teammates exist, because they
// point at them.
// ---------------------------------------------------------------------------

export interface WatcherScenarioOptions {
  adminId: string;
  instruments: SeededInstrument[];
  runs: SeededRun[];
  teammates: SeededTeammate[];
  watchers: SeededWatcher[];
}

// An item from a list, wrapping around the end. Throws when the list is empty.
function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) {
    throw new Error("Nothing to pick from");
  }
  return item;
}

// How many of the given events fall in the `step` minutes that a heartbeat
// `minutesAgo` before the seed runs reports on.
function countSinceHeartbeat(
  eventsAgo: readonly number[],
  minutesAgo: number,
  step: number
): number {
  return eventsAgo.filter((ago) => ago > minutesAgo && ago <= minutesAgo + step)
    .length;
}

// A watcher that was deregistered. It ran from `registeredDaysAgo` until
// `deregisteredDaysAgo`, and its last heartbeat came five minutes before that.
async function seedPastWatcher(
  db: Db,
  instrument: SeededInstrument,
  past: SeededPastWatcher,
  scenario: { adminId: string; now: Date; runs: SeededRun[] }
): Promise<void> {
  const { now } = scenario;
  const template = templateOf(instrument);
  const id = crypto.randomUUID();
  const { configYaml, configChecksum } = renderWatcherConfig(template, id);
  const registeredAgo = past.registeredDaysAgo * MINUTES_PER_DAY;
  const deregisteredAgo = past.deregisteredDaysAgo * MINUTES_PER_DAY;
  const lastSeenAgo = deregisteredAgo + 5;

  await db.insert(schema.watchers).values({
    id,
    instrumentId: instrument.id,
    hostname: past.hostname,
    osInfo: past.osInfo,
    watcherVersion: SEED_WATCHER_VERSION,
    configChecksum,
    configYaml,
    createdAt: minutesBefore(now, registeredAgo),
    lastHeartbeatAt: minutesBefore(now, lastSeenAgo),
    status: "stopped",
    statusReason: null,
    configRevision: 1,
    appliedConfigRevision: 1,
    deletedAt: minutesBefore(now, deregisteredAgo),
    deregisteredBy: scenario.adminId,
  });

  await db.insert(schema.watcherConfigRevisions).values(
    revisionRow(id, 1, "web", "applied", settingsFromTemplate(template), {
      createdBy: scenario.adminId,
      createdAt: minutesBefore(now, registeredAgo + 1),
      resolvedAt: minutesBefore(now, registeredAgo),
    })
  );

  // Heartbeats for its last three days, five minutes apart.
  const oldestAgo = Math.min(registeredAgo, lastSeenAgo + 3 * MINUTES_PER_DAY);
  const heartbeats: WatcherHeartbeatRow[] = [];
  for (let minutesAgo = lastSeenAgo; minutesAgo <= oldestAgo; minutesAgo += 5) {
    heartbeats.push(
      heartbeatRow(
        id,
        minutesBefore(now, minutesAgo),
        minutesAgo === lastSeenAgo ? "stopped" : "watching",
        "auto",
        (registeredAgo - minutesAgo) * 60
      )
    );
  }
  await insertHeartbeatRows(db, heartbeats);

  const [run] = scenario.runs;
  const events: WatcherEventRow[] = [
    eventRow(
      id,
      "watcher_started",
      `Service started on ${past.hostname}`,
      minutesBefore(now, registeredAgo)
    ),
    eventRow(
      id,
      "config_synced",
      "Config synced from server",
      minutesBefore(now, registeredAgo - 1)
    ),
  ];
  if (run) {
    events.push(
      fileUploadedEvent(
        id,
        minutesBefore(now, Math.round((registeredAgo + deregisteredAgo) / 2)),
        instrument.id,
        run.runId,
        "scan-archive.csv",
        40_960
      )
    );
  }
  events.push(
    eventRow(
      id,
      "watcher_stopped",
      "Service stopped: its registration was deleted on Data Hub",
      minutesBefore(now, deregisteredAgo)
    )
  );
  await insertEventRows(db, events);
}

// A week of heartbeats, uploads, run reports, restarts and gaps for a watcher
// with a WATCHER_HISTORY plan. The watcher row itself is seeded by seedWatchers.
async function seedWatcherHistory(
  db: Db,
  instrument: SeededInstrument,
  watcherId: string,
  plan: WatcherHistoryPlan,
  runs: SeededRun[],
  now: Date
): Promise<void> {
  if (runs.length === 0) {
    throw new Error(`${instrument.id} needs seeded runs for its history`);
  }
  const { hostname } = watcherIdentity(instrument);
  const step = plan.stepMinutes;
  const historyMinutes = HISTORY_DAYS * MINUTES_PER_DAY;

  const events: WatcherEventRow[] = [
    eventRow(
      watcherId,
      "watcher_started",
      `Service started on ${hostname}`,
      minutesBefore(now, historyMinutes)
    ),
    eventRow(
      watcherId,
      "config_synced",
      "Config synced from server",
      minutesBefore(now, historyMinutes - 1)
    ),
  ];

  // Uploads and run reports, every day of the week.
  const uploadAgos: number[] = [];
  const reportAgos: number[] = [];
  for (let day = 0; day < HISTORY_DAYS; day++) {
    const dayStart = day * MINUTES_PER_DAY;
    for (const [n, offset] of UPLOAD_MINUTES_OF_DAY.slice(
      0,
      plan.uploadsPerDay
    ).entries()) {
      const agoMinutes = dayStart + offset;
      const run = pick(runs, day + n);
      events.push(
        fileUploadedEvent(
          watcherId,
          minutesBefore(now, agoMinutes),
          instrument.id,
          run.runId,
          `scan-${day + 1}-${n + 1}.csv`,
          20_480 + n * 4096 + day * 512
        )
      );
      uploadAgos.push(agoMinutes);
    }
    const reported = pick(runs, day);
    const reportAgo = dayStart + RUN_REPORT_MINUTE_OF_DAY;
    events.push(
      eventRow(
        watcherId,
        "run_reported",
        `Run ${reported.runId} reported`,
        minutesBefore(now, reportAgo),
        { run_id: reported.runId }
      )
    );
    reportAgos.push(reportAgo);
  }

  for (const restart of plan.restarts) {
    const resumedAgo = restart.stoppedMinutesAgo - restart.gapMinutes;
    events.push(
      eventRow(
        watcherId,
        "update_started",
        `Upgrading watcher ${restart.from} -> ${restart.to}`,
        minutesBefore(now, restart.stoppedMinutesAgo + 1),
        {
          current_version: restart.from,
          target_version: restart.to,
          mandatory: false,
          install_method: "uv-tool",
        }
      ),
      eventRow(
        watcherId,
        "watcher_stopped",
        "Service restarting for auto-update",
        minutesBefore(now, restart.stoppedMinutesAgo)
      ),
      eventRow(
        watcherId,
        "watcher_started",
        `Service started on ${hostname}`,
        minutesBefore(now, resumedAgo)
      ),
      eventRow(
        watcherId,
        "update_succeeded",
        `Restarted into upgraded watcher ${restart.from} -> ${restart.to}`,
        new Date(minutesBefore(now, resumedAgo).getTime() + 30_000),
        { previous_version: restart.from, target_version: restart.to }
      )
    );
  }

  for (const recovery of plan.recoveries) {
    events.push(
      eventRow(
        watcherId,
        "error",
        `Heartbeat recovered after ${recovery.missedHeartbeats} consecutive failure(s)`,
        minutesBefore(now, recovery.recoveredMinutesAgo),
        {
          kind: "heartbeat_recovered",
          consecutive_failures: recovery.missedHeartbeats,
          gap_seconds: (recovery.missedHeartbeats + 1) * step * 60,
        }
      )
    );
  }

  if (plan.failedUploadMinutesAgo !== undefined) {
    const failedRun = pick(runs, 0);
    events.push(
      eventRow(
        watcherId,
        "upload_failed",
        "Upload failed: scan-failed.csv",
        minutesBefore(now, plan.failedUploadMinutesAgo),
        {
          error: "The upload timed out before storage confirmed it",
          s3_key: `${instrument.id}/${failedRun.runId}/scan-failed.csv`,
        }
      )
    );
  }

  // Heartbeats, oldest first. A restart's stop heartbeat reads "stopped", and
  // the watcher comes back `gapMinutes` later. A recovery gap has no heartbeats
  // until the one that ends it.
  const stops = new Set(plan.restarts.map((r) => r.stoppedMinutesAgo));
  const resumes = new Set(
    plan.restarts.map((r) => r.stoppedMinutesAgo - r.gapMinutes)
  );
  const inGap = (minutesAgo: number): boolean =>
    plan.restarts.some(
      (r) =>
        minutesAgo > r.stoppedMinutesAgo - r.gapMinutes &&
        minutesAgo < r.stoppedMinutesAgo
    ) ||
    plan.recoveries.some(
      (r) =>
        minutesAgo > r.recoveredMinutesAgo &&
        minutesAgo < r.recoveredMinutesAgo + (r.missedHeartbeats + 1) * step
    );

  const heartbeats: WatcherHeartbeatRow[] = [];
  let runStartedAgo = historyMinutes;
  for (let minutesAgo = historyMinutes; minutesAgo >= 0; minutesAgo -= step) {
    if (inGap(minutesAgo)) {
      continue;
    }
    if (resumes.has(minutesAgo)) {
      runStartedAgo = minutesAgo;
    }
    heartbeats.push(
      heartbeatRow(
        watcherId,
        minutesBefore(now, minutesAgo),
        stops.has(minutesAgo) ? "stopped" : "watching",
        "auto",
        (runStartedAgo - minutesAgo) * 60,
        countSinceHeartbeat(uploadAgos, minutesAgo, step),
        countSinceHeartbeat(reportAgos, minutesAgo, step)
      )
    );
  }

  await insertHeartbeatRows(db, heartbeats);
  await insertEventRows(db, events);
}

async function setRevisionNumbers(
  db: Db,
  watcherId: string,
  configRevision: number,
  appliedConfigRevision: number
): Promise<void> {
  await db
    .update(schema.watchers)
    .set({ configRevision, appliedConfigRevision })
    .where(eq(schema.watchers.id, watcherId));
}

// Three watchers, one in each config state. A save always makes a new
// revision; the watcher's next report moves it to applied or rejected.
async function seedConfigChanges(
  db: Db,
  options: {
    adminId: string;
    now: Date;
    pendingBy: string;
    rejectedBy: string;
    settingsOf: (instrumentId: string) => WatcherConfigSettings;
    templateOf: (instrumentId: string) => string;
    watcherOf: (instrumentId: string) => string;
  }
): Promise<void> {
  const { adminId, now } = options;

  // Pending: a teammate saved a change while the watcher was stopped, so the
  // change waits until the watcher starts again.
  const stopped = options.watcherOf("instantraman");
  const stoppedBase = options.settingsOf("instantraman");
  await db.insert(schema.watcherConfigRevisions).values([
    revisionRow(stopped, 1, "web", "applied", stoppedBase, {
      createdBy: adminId,
      createdAt: minutesBefore(now, 10 * MINUTES_PER_DAY + 1),
      resolvedAt: minutesBefore(now, 10 * MINUTES_PER_DAY),
    }),
    revisionRow(
      stopped,
      2,
      "web",
      "pending",
      { ...stoppedBase, stability_period_seconds: 10, upload_parallelism: 2 },
      { createdBy: options.pendingBy, createdAt: minutesBefore(now, 180) }
    ),
  ]);
  await setRevisionNumbers(db, stopped, 2, 1);
  await insertEventRows(db, [
    appliedEvent(stopped, 1, minutesBefore(now, 10 * MINUTES_PER_DAY)),
  ]);

  // Rejected: the watcher could not use the new watch folder, and said why.
  const rejected = options.watcherOf("spectramax-id3-plate-reader");
  const rejectedBase = options.settingsOf("spectramax-id3-plate-reader");
  const rejectionReason =
    "The watcher could not read the new watch folder on this PC.";
  await db.insert(schema.watcherConfigRevisions).values([
    revisionRow(rejected, 1, "web", "applied", rejectedBase, {
      createdBy: adminId,
      createdAt: minutesBefore(now, 6 * MINUTES_PER_DAY + 1),
      resolvedAt: minutesBefore(now, 6 * MINUTES_PER_DAY),
    }),
    revisionRow(
      rejected,
      2,
      "web",
      "rejected",
      { ...rejectedBase, watch_directory: "C:\\Data\\SpectraMaxID3Archive" },
      {
        createdBy: options.rejectedBy,
        createdAt: minutesBefore(now, 120),
        resolvedAt: minutesBefore(now, 105),
        statusReason: rejectionReason,
      }
    ),
  ]);
  await setRevisionNumbers(db, rejected, 2, 1);
  await insertEventRows(db, [
    appliedEvent(rejected, 1, minutesBefore(now, 6 * MINUTES_PER_DAY)),
    rejectedEvent(rejected, 2, rejectionReason, minutesBefore(now, 105)),
  ]);

  // Edited on the PC: the PC's revision is applied, but the watcher reads its
  // config only at startup, so it still runs revision 1. The PC pushed the
  // edited file, so the server's copy of the config is the edited one.
  const edited = options.watcherOf("agilent-4150-tapestation");
  const editedBase = options.settingsOf("agilent-4150-tapestation");
  const editedTemplate = options
    .templateOf("agilent-4150-tapestation")
    .replace(/^( {2}file_patterns:\n(?: {2}- .*\n)+)/m, "$1  - '*.txt'\n");
  const editedSettings = settingsFromTemplate(editedTemplate);
  if (editedSettings.file_patterns.length <= editedBase.file_patterns.length) {
    throw new Error("The edited-on-PC config did not gain a file pattern");
  }
  await db.insert(schema.watcherConfigRevisions).values([
    revisionRow(edited, 1, "web", "applied", editedBase, {
      createdBy: adminId,
      createdAt: minutesBefore(now, 5 * MINUTES_PER_DAY + 1),
      resolvedAt: minutesBefore(now, 5 * MINUTES_PER_DAY),
    }),
    revisionRow(edited, 2, "pc", "applied", editedSettings, {
      createdAt: minutesBefore(now, 40),
      resolvedAt: minutesBefore(now, 40),
    }),
  ]);
  const { configYaml, configChecksum } = renderWatcherConfig(
    editedTemplate,
    edited
  );
  await db
    .update(schema.watchers)
    .set({ configYaml, configChecksum })
    .where(eq(schema.watchers.id, edited));
  await setRevisionNumbers(db, edited, 2, 1);
  await insertEventRows(db, [
    appliedEvent(edited, 1, minutesBefore(now, 5 * MINUTES_PER_DAY)),
  ]);
}

// A run with files waiting for upload: detected, or upload requested and not
// yet uploaded. Times are minutes before the seed runs.
async function seedWaitingRun(
  db: Db,
  run: {
    acquiredAgo: number;
    createdAgo: number;
    files: {
      detectedAgo: number;
      name: string;
      requestedAgo?: number;
      status: "detected" | "upload_requested";
    }[];
    instrumentId: string;
    now: Date;
    runId: string;
    watcherId: string;
  }
): Promise<void> {
  const [row] = await db
    .insert(schema.instrumentRuns)
    .values({
      instrumentId: run.instrumentId,
      runId: run.runId,
      source: "watcher",
      watcherId: run.watcherId,
      metadata: { seeded: true },
      acquiredAt: minutesBefore(run.now, run.acquiredAgo),
      createdAt: minutesBefore(run.now, run.createdAgo),
    })
    .returning({ id: schema.instrumentRuns.id });
  if (!row) {
    throw new Error(`Could not seed run ${run.runId}`);
  }
  await db.insert(schema.files).values(
    run.files.map((file) => ({
      instrumentRunId: row.id,
      relativePath: file.name,
      filename: file.name,
      contentType: "text/csv",
      sizeBytes: 4096,
      category: "raw" as const,
      status: file.status,
      metadata: { seeded: true },
      detectedAt: minutesBefore(run.now, file.detectedAgo),
      uploadRequestedAt:
        file.requestedAgo === undefined
          ? null
          : minutesBefore(run.now, file.requestedAgo),
    }))
  );
}

// The token a pending instrument's watcher registered with, so that its
// registration names a token instead of being claimed on first use.
async function seedPendingWatcherToken(
  db: Db,
  adminId: string,
  watcherId: string,
  now: Date
): Promise<void> {
  const watcherPreset = SCOPE_PRESETS.find((preset) => preset.id === "watcher");
  if (!watcherPreset) {
    throw new Error("The watcher scope preset is missing");
  }
  const plaintext = generateToken();
  const [token] = await db
    .insert(schema.personalAccessTokens)
    .values({
      createdBy: adminId,
      name: "Lab PC token",
      tokenHash: hashToken(plaintext),
      tokenPrefix: getTokenPrefix(plaintext),
      scopes: [...watcherPreset.scopes],
      lastUsedAt: minutesBefore(now, 20),
    })
    .returning({ id: schema.personalAccessTokens.id });
  if (!token) {
    throw new Error("Could not seed the pending watcher's token");
  }
  await db
    .update(schema.watchers)
    .set({ registeredByToken: token.id })
    .where(eq(schema.watchers.id, watcherId));
}

// Writes the watcher states that need more than seedWatchers does. Call it
// after seedWatchers, seedRuns and seedTeammates, because it points at them.
export async function seedWatcherScenarios(
  db: Db,
  options: WatcherScenarioOptions
): Promise<void> {
  const now = new Date();
  const instrumentById = new Map(
    options.instruments.map(
      (instrument) => [instrument.id, instrument] as const
    )
  );
  const watcherIdByInstrument = new Map(
    options.watchers.map(
      (watcher) => [watcher.instrumentId, watcher.id] as const
    )
  );
  const runsOf = (instrumentId: string): SeededRun[] =>
    options.runs.filter((run) => run.instrumentId === instrumentId);
  const instrumentOf = (instrumentId: string): SeededInstrument => {
    const instrument = instrumentById.get(instrumentId);
    if (!instrument) {
      throw new Error(`No seeded instrument ${instrumentId}`);
    }
    return instrument;
  };
  const watcherOf = (instrumentId: string): string => {
    const watcherId = watcherIdByInstrument.get(instrumentId);
    if (!watcherId) {
      throw new Error(`No seeded watcher for ${instrumentId}`);
    }
    return watcherId;
  };
  const [pendingBy, rejectedBy] = options.teammates;
  if (!(pendingBy && rejectedBy)) {
    throw new Error("The seed needs two teammates");
  }

  for (const instrument of options.instruments) {
    for (const past of instrument.pastWatchers ?? []) {
      await seedPastWatcher(db, instrument, past, {
        adminId: options.adminId,
        now,
        runs: runsOf(instrument.id),
      });
    }
  }

  for (const [instrumentId, plan] of Object.entries(WATCHER_HISTORY)) {
    if (plan) {
      await seedWatcherHistory(
        db,
        instrumentOf(instrumentId),
        watcherOf(instrumentId),
        plan,
        runsOf(instrumentId),
        now
      );
    }
  }

  await seedConfigChanges(db, {
    adminId: options.adminId,
    now,
    pendingBy: pendingBy.id,
    rejectedBy: rejectedBy.id,
    settingsOf: (instrumentId) =>
      settingsFromTemplate(templateOf(instrumentOf(instrumentId))),
    templateOf: (instrumentId) => templateOf(instrumentOf(instrumentId)),
    watcherOf,
  });

  // Balance F is unresponsive: these files were detected before it went silent.
  // They have no upload requests, because the server reverts upload requests
  // to a watcher that stays silent for 15 minutes.
  await seedWaitingRun(db, {
    instrumentId: "balance-f",
    now,
    runId: "weighing-batch-a",
    watcherId: watcherOf("balance-f"),
    acquiredAgo: 150,
    createdAgo: 140,
    files: [
      { name: "weigh-0001.csv", status: "detected", detectedAgo: 140 },
      { name: "weigh-0002.csv", status: "detected", detectedAgo: 135 },
      { name: "weigh-0003.csv", status: "detected", detectedAgo: 130 },
      { name: "weigh-0004.csv", status: "detected", detectedAgo: 128 },
    ],
  });

  // Thermal Mixer H is restarting, so the requests made since it stopped queue
  // until it is back.
  await seedWaitingRun(db, {
    instrumentId: "thermal-mixer-h",
    now,
    runId: "mixer-run-b",
    watcherId: watcherOf("thermal-mixer-h"),
    // Older than the catalog's newest run, so this instrument stays out of the
    // dashboard's most recent three. Its files were detected a few minutes ago.
    acquiredAgo: 180,
    createdAgo: 30,
    files: [
      { name: "mix-0001.csv", status: "detected", detectedAgo: 30 },
      {
        name: "mix-0002.csv",
        status: "upload_requested",
        detectedAgo: 28,
        requestedAgo: 2,
      },
      {
        name: "mix-0003.csv",
        status: "upload_requested",
        detectedAgo: 27,
        requestedAgo: 2,
      },
    ],
  });

  await seedPendingWatcherToken(
    db,
    options.adminId,
    watcherOf("seed-pending-instrument"),
    now
  );
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
// `seedRunComments` (0 = Alice / admin). Threads are keyed by instrument so
// docs screenshots don't show gel talk on a TapeStation run.
const COMMENT_THREADS_BY_INSTRUMENT: Record<string, CommentThreadBeat[][]> = {
  "azure-600-gel-doc": [
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
        authorIndex: 6,
        body: "@Alice can we reprocess this? The preview PNG looks washed out compared to the TIFF.",
        hoursAgo: 12,
      },
      {
        authorIndex: 0,
        body: "Reprocessing now — chemiluminescence and fluorescence can need different stretch settings.",
        hoursAgo: 11,
      },
      {
        authorIndex: 6,
        body: "Looks good after reprocess. Thanks!",
        hoursAgo: 10,
      },
    ],
  ],
  "azure-cielo-qpcr": [
    [
      {
        authorIndex: 3,
        body: "Cq values look consistent across tech replicates. Anyone else seeing the late amp in H12?",
        hoursAgo: 26,
      },
      {
        authorIndex: 4,
        body: "@David H12 was the NTC — expected. Everything else looks good to proceed.",
        hoursAgo: 25,
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
  ],
  "spectramax-id3-plate-reader": [
    [
      {
        authorIndex: 5,
        body: "Plate map is in the notebook under 2026-07-14 / ELM Comp. Rows A–D are 1:5 dilutions.",
        hoursAgo: 30,
      },
    ],
    [
      {
        authorIndex: 2,
        body: "OD595 kinetic looks clean after blank subtraction. Claiming this one.",
        hoursAgo: 8,
      },
      {
        authorIndex: 0,
        body: "Thanks @Carol — agreed on the curve shape.",
        hoursAgo: 7,
      },
    ],
  ],
  "spectramax-id5-plate-reader": [
    [
      {
        authorIndex: 5,
        body: "Well-scan heatmap matches the endpoint plate map. Rows A–D are 1:5 dilutions.",
        hoursAgo: 30,
      },
    ],
    [
      {
        authorIndex: 2,
        body: "Fluorescence endpoint looks consistent across tech replicates.",
        hoursAgo: 8,
      },
      {
        authorIndex: 0,
        body: "Thanks @Carol — claiming this one.",
        hoursAgo: 7,
      },
    ],
  ],
  "agilent-4150-tapestation": [
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
  ],
  "hina-microscope": [
    [
      {
        authorIndex: 10,
        body: "Z-stack looks solid through planes 2–4. Plane 1 is a bit dim on FITC.",
        hoursAgo: 2,
      },
    ],
    [
      {
        authorIndex: 1,
        body: "@Alice — channel labels look right (BF / FITC / TRITC). OK to keep the full well grid?",
        hoursAgo: 5,
      },
      {
        authorIndex: 0,
        body: "Yes — keep all points. We can subsample later if storage becomes an issue.",
        hoursAgo: 4.5,
      },
    ],
  ],
  "epson-v700-scanner": [
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
  ],
  instantraman: [
    [
      {
        authorIndex: 3,
        body: "Site spectra look consistent across the plate. Anyone else seeing the outlier at H10?",
        hoursAgo: 26,
      },
      {
        authorIndex: 4,
        body: "@David H10 was the solvent blank — expected. Everything else looks good to proceed.",
        hoursAgo: 25,
      },
    ],
  ],
};

// Fallback for instruments without a dedicated thread pool (Aunty, Jolene, …).
const GENERIC_COMMENT_THREADS: CommentThreadBeat[][] = [
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
      authorIndex: 2,
      body: "Logged in the notebook under today's date. Claiming this one.",
      hoursAgo: 8,
    },
    {
      authorIndex: 0,
      body: "Thanks @Carol — looks consistent with the prior replicate.",
      hoursAgo: 7,
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
  // Per-instrument index so thread selection stays stable for a given
  // instrument regardless of how many runs other instruments contributed.
  const instrumentRunIdx = new Map<string, number>();

  for (const [runIndex, run] of runs.entries()) {
    const idxOnInstrument = instrumentRunIdx.get(run.instrumentId) ?? 0;
    instrumentRunIdx.set(run.instrumentId, idxOnInstrument + 1);

    // Rich threads on every third run; everyone else gets a short note so
    // the comments column isn't empty in list views.
    if (idxOnInstrument % 3 === 0) {
      const pool =
        COMMENT_THREADS_BY_INSTRUMENT[run.instrumentId] ??
        GENERIC_COMMENT_THREADS;
      const thread = pool[idxOnInstrument % pool.length];
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
        idxOnInstrument % 4 === 3
          ? `Checked ${run.runId} last week — looks consistent with the prior replicate.`
          : `Logged ${run.runId}. Samples stored in box ${String.fromCharCode(65 + (runIndex % 6))}-${(runIndex % 9) + 1}.`,
      createdAt: idxOnInstrument % 4 === 3 ? lastWeekCommentAt : new Date(),
    });
  }

  // Pin one comment to yesterday noon and one to the same instant last year
  // so the /comments day headings always include Yesterday and a prior-year
  // date, independent of when the seed runs.
  const yesterdayNoon = new Date(
    new Date(startOfYesterdayISO(timeZone)).getTime() + 12 * HOUR_MS
  );
  const lastYearNoon = new Date(yesterdayNoon);
  lastYearNoon.setUTCFullYear(lastYearNoon.getUTCFullYear() - 1);
  const anchorRun = runs[0];
  const anchorAuthor = authors[1 % authors.length];
  rows.push(
    {
      runId: anchorRun.id,
      userId: anchorAuthor.id,
      body: "Flagging yesterday's batch — the blank wells drifted after calibration.",
      createdAt: yesterdayNoon,
    },
    {
      runId: anchorRun.id,
      userId: authors[0].id,
      body: "Archived note from last year's calibration. Kept for the QC binder.",
      createdAt: lastYearNoon,
    }
  );

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

// Synthetic lab notebooks. Every other run is in one, and every sixth run is
// in a second, so list views show the column, its "+1", and its filter. One
// notebook has no runs yet, and one is deleted, so the Notebooks list and its
// "Show deleted" filter have something to show.
const NOTEBOOK_PAGES: Array<{
  url: string;
  name: string;
  description: string | null;
  runs: boolean;
  deleted?: boolean;
}> = [
  {
    url: "https://www.notion.so/example-lab/Heat-stress-time-course-0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    name: "Heat stress time course",
    description: "Growth at 30, 37 and 42 °C, sampled every two hours.",
    runs: true,
  },
  {
    url: "https://www.notion.so/example-lab/Osmotic-stress-panel-1b2c3d4e5f60718293a4b5c6d7e8f90a",
    name: "Osmotic stress panel",
    description: null,
    runs: true,
  },
  {
    url: "https://eln.example.com/entries/gel-ladder-calibration",
    name: "Gel ladder calibration",
    description: "Ladder lots compared on the gel doc.",
    runs: true,
  },
  {
    url: "https://www.notion.so/example-lab/Plasmid-screen-round-2-2c3d4e5f60718293a4b5c6d7e8f90a1b",
    name: "Plasmid screen round 2",
    description: "Set up before the first plates are read.",
    runs: false,
  },
  {
    url: "https://www.notion.so/example-lab/Old-media-test-3d4e5f60718293a4b5c6d7e8f90a1b2c",
    name: "Old media test",
    description: null,
    runs: false,
    deleted: true,
  },
];

export async function seedNotebooks(
  db: Db,
  runs: SeededRun[],
  userIds: string[]
): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  const inserted = await db
    .insert(schema.notebooks)
    .values(
      NOTEBOOK_PAGES.map((page, i) => {
        const parsed = parseNotebookLinkUrl(page.url);
        if (!parsed) {
          throw new Error(`Seed notebook URL is invalid: ${page.url}`);
        }
        const userId = userIds[i % userIds.length];
        return {
          url: parsed.url,
          urlKey: parsed.urlKey,
          name: page.name,
          description: page.description,
          ownerId: i === 1 ? null : userId,
          createdBy: userId,
          updatedBy: userId,
          ...(page.deleted && { deletedAt: new Date(), deletedBy: userId }),
        };
      })
    )
    .returning({ id: schema.notebooks.id });
  const withRuns = inserted.filter((_, i) => NOTEBOOK_PAGES[i].runs);

  type LinkInsert = typeof schema.runNotebookLinks.$inferInsert;
  const rows: LinkInsert[] = [];
  for (const [i, run] of runs.entries()) {
    if (i % 2 !== 0) {
      continue;
    }
    const picked = [withRuns[i % withRuns.length]];
    if (i % 6 === 0) {
      picked.push(withRuns[(i + 1) % withRuns.length]);
    }
    for (const notebook of picked) {
      rows.push({
        runId: run.id,
        notebookId: notebook.id,
        createdBy: userIds[i % userIds.length],
      });
    }
  }
  if (rows.length > 0) {
    await db.insert(schema.runNotebookLinks).values(rows);
  }
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
  { name: "Frank Upton", email: "frank@example.com" },
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
    emailVerified: true,
    isAdmin: false,
  }));
  await db.insert(schema.users).values(rows);
  for (const row of rows) {
    await seedCredentialAccount(db, row.id);
  }
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
//   - Today: two comment notifications from the same teammate so the
//     comment-on-your-run + follow-up pattern lands under Today.
//   - Yesterday: grouped `run_created` rows — 8 on the iD5 (enough to
//     exercise the 5-row cutoff + show-more), plus smaller groups on the
//     iD3 and Aunty. A few of the iD5 rows are already read so the unread
//     dot contrast shows up inside one group.
//   - Older: one already-read `comment_participated` row so a weekday
//     heading (not Today/Yesterday) appears below.
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
  // Prefer plate-reader runs so the OD-worded today comments match the
  // instrument in the notification deep-link (falls back to any runs).
  const plateReaderRuns = runs.filter(
    (r) =>
      r.instrumentId === "spectramax-id3-plate-reader" ||
      r.instrumentId === "spectramax-id5-plate-reader"
  );
  const todayCommentTargets = (
    plateReaderRuns.length >= 2 ? plateReaderRuns : runs
  ).slice(0, 2);
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
  // Yesterday: grouped `run_created` rows. Prefer named instruments so the
  // local bell matches the redesign mock (iD5 is the large expandable
  // group). Fall back to whatever the seed actually produced.
  // -------------------------------------------------------------------------

  // 6 PM yesterday, local. Stamps stay inside yesterday regardless of
  // when a developer runs `db:seed`.
  const yesterdayBaseline = new Date(startOfToday.getTime() - 6 * HOUR);

  const groupBatches: Array<{ instrumentId: string; count: number }> = [
    { instrumentId: "spectramax-id5-plate-reader", count: 8 },
    { instrumentId: "spectramax-id3-plate-reader", count: 3 },
    { instrumentId: "unchained-labs-aunty", count: 2 },
  ];

  groupBatches.forEach((batch, batchIdx) => {
    const named = runsByInstrument.get(batch.instrumentId);
    const fallbackId = instrumentIds[batchIdx];
    const pool =
      named ??
      (fallbackId ? runsByInstrument.get(fallbackId) : undefined) ??
      [];
    const picks = pool.slice(0, batch.count);
    picks.forEach((run, i) => {
      // Newest two iD5 rows stay unread so the visible slice mixes dotted
      // and undotted run rows; the rest are already read.
      const markRead =
        batch.instrumentId === "spectramax-id5-plate-reader" && i >= 2;
      notifRows.push({
        userId: recipientUserId,
        type: "run_created",
        runId: run.id,
        createdAt: new Date(
          yesterdayBaseline.getTime() - (batchIdx * HOUR + i * 40 * 60_000)
        ),
        readAt: markRead
          ? new Date(yesterdayBaseline.getTime() - 30 * 60_000)
          : null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Older than yesterday: one already-read `comment_participated` row so
  // the weekday heading and the read-row treatment both show. The admin
  // has seeded comments on many runs via `seedRunComments`, so any run
  // qualifies for the participated trigger.
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
