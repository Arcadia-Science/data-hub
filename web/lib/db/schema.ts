import type { AdapterAccountType } from "@auth/core/adapters";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const instrumentStatusEnum = pgEnum("instrument_status", [
  "pending",
  "active",
  "inactive",
]);

export const watcherStatusEnum = pgEnum("watcher_status", [
  "registered",
  "watching",
  "stopped",
]);

export const watcherEventTypeEnum = pgEnum("watcher_event_type", [
  "watcher_started",
  "watcher_stopped",
  "file_uploaded",
  "upload_failed",
  "run_reported",
  "config_synced",
  "error",
  // Auto-update lifecycle events emitted by the in-process updater. See
  // `watcher/src/data_hub_watcher/updater.py` for the state machine.
  "update_started",
  "update_succeeded",
  "update_failed",
]);

export const uploadModeEnum = pgEnum("upload_mode", ["auto", "manual"]);

export const instrumentRunSourceEnum = pgEnum("instrument_run_source", [
  "lambda",
  "watcher",
]);

export const instrumentTypeEnum = pgEnum("instrument_type", [
  "generic",
  "plate_reader",
  "gel_doc",
  "qpcr",
  "tape_station",
  "hina_microscope",
  "epson_v700_scanner",
  "instant_raman",
]);

export const VALID_INSTRUMENT_TYPES = instrumentTypeEnum.enumValues;
export type InstrumentType = (typeof VALID_INSTRUMENT_TYPES)[number];

export const fileCategoryEnum = pgEnum("file_category", ["raw", "processed"]);

export const fileStatusEnum = pgEnum("file_status", [
  "detected",
  "upload_requested",
  "uploaded",
  "processing",
  "completed",
  "failed",
]);

export const archiveJobStatusEnum = pgEnum("archive_job_status", [
  "pending",
  "building",
  "ready",
  "failed",
]);

export const users = pgTable("user", {
  // Auth.js-generated user ID.
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // Display name from Google profile.
  name: text("name"),
  // Google email address.
  email: text("email").unique(),
  // When the email was verified.
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  // Profile image URL from Google.
  image: text("image"),
  // Workspace-wide admin flag. Bootstrapped from the `ADMIN_EMAILS` env var
  // at sign-in (see `web/lib/auth.ts`); subsequent toggles happen via the
  // admin-only `/settings/members` page. Used to gate session-authenticated
  // mutations (PAT create/delete, instrument edits, member toggles). PAT-
  // authenticated requests are unaffected — they're still authorized by
  // `personal_access_tokens.scopes`.
  isAdmin: boolean("is_admin").notNull().default(false),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Account type (e.g., `oauth`).
    type: text("type").$type<AdapterAccountType>().notNull(),
    // OAuth provider (e.g., `google`).
    provider: text("provider").notNull(),
    // Provider's user ID.
    providerAccountId: text("providerAccountId").notNull(),
    // OAuth refresh token.
    refresh_token: text("refresh_token"),
    // OAuth access token.
    access_token: text("access_token"),
    // Token expiry (Unix timestamp).
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
    index("idx_accounts_user_id").on(account.userId),
  ]
);

export const sessions = pgTable(
  "session",
  {
    // Opaque session token.
    sessionToken: text("sessionToken").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Session expiry.
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (session) => [index("idx_sessions_user_id").on(session.userId)]
);

// Singleton row of server-advertised watcher release metadata, served by
// `GET /api/v1/watchers/:id/update-check` and edited via the admin-only
// `/settings/watchers` page. Previously sourced from the
// `WATCHER_LATEST_VERSION` / `WATCHER_MIN_SUPPORTED_VERSION` /
// `WATCHER_RELEASE_CHANNEL` / `WATCHER_MANDATORY_UPDATE` env vars.
//
// The `id boolean PRIMARY KEY DEFAULT true` + check constraint is the
// standard Postgres singleton trick — schema-level guarantee of at most
// one row, so callers don't need any `LIMIT 1` discipline and concurrent
// upserts collapse onto the same row via `ON CONFLICT (id) DO UPDATE`.
//
// When the table is empty (fresh deploy, before any admin has saved) the
// update-check endpoint returns `latest_version: null`, the same
// "no update info available" sentinel watchers already understand.
export const watcherReleaseConfig = pgTable(
  "watcher_release_config",
  {
    id: boolean("id").primaryKey().default(true),
    // Required to advertise a release. NULL → watchers skip the upgrade
    // attempt.
    latestVersion: text("latest_version"),
    // Optional floor enforced on the heartbeat path: watchers reporting an
    // installed version below this are rejected with 426 Upgrade Required
    // (see `app/api/v1/watchers/[watcherId]/heartbeat/route.ts`) so they
    // can't continue checking in without self-updating first.
    minSupportedVersion: text("min_supported_version"),
    // Defaults to "stable"; surfaced in the response and shown in
    // `self-update` output.
    channel: text("channel").notNull().default("stable"),
    // When true, the release skips the watcher's activity-window guard so
    // mid-acquisition PCs upgrade immediately. Has no effect when
    // `latest_version` is NULL — `update-check` collapses it to false on
    // read so the wire response stays self-consistent.
    mandatory: boolean("mandatory").notNull().default(false),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // The admin who last saved this row. NULL only after a deleted user
    // cascade — the route always stamps the authenticated user id on
    // write.
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (config) => [
    check("watcher_release_config_singleton", sql`${config.id} = true`),
  ]
);

export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The user who created this token.
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // User-provided label (e.g., "Plate Reader PC", "Lambda production").
    name: text("name").notNull(),
    // SHA-256 hash of the token. The plaintext token is shown once at creation
    // and never stored.
    tokenHash: text("token_hash").notNull().unique(),
    // First 8 characters of the token, stored for display purposes
    // (e.g., `dhub_a1b2...`).
    tokenPrefix: text("token_prefix").notNull(),
    // Permission scopes granted to this token (e.g., `runs:read`,
    // `files:write`). The wildcard `*` matches everything and is used as
    // the backfill value for pre-scope tokens. New tokens created via the
    // API always carry an explicit, non-wildcard scope list. Enforcement
    // happens in each v1 route via `authorize(request, "<scope>")`.
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`ARRAY['*']::text[]`),
    // Updated on each API call authenticated with this token.
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Optional expiry. NULL means no expiry.
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (token) => [index("idx_personal_access_tokens_user_id").on(token.userId)]
);

export const instruments = pgTable("instruments", {
  // Kebab-case identifier (e.g., `spectramax-id3-plate-reader`). Also used as
  // the first segment of the S3 key (`{instrument_id}/{run_id}/{filename}`).
  id: text("id").primaryKey(),
  // Human-readable name (e.g., "SpectraMax iD3 Plate Reader").
  displayName: text("display_name").notNull(),
  // New instruments registered via the watcher CLI start as `pending` until
  // confirmed by an admin.
  status: instrumentStatusEnum("status").notNull().default("active"),
  // Categorises the instrument for variant-specific UI (e.g., plate reader
  // runs display a plate map grid). Defaults to "generic" for existing rows.
  instrumentType: instrumentTypeEnum("instrument_type")
    .notNull()
    .default("generic"),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const watchers = pgTable(
  "watchers",
  {
    // The watcher_id returned to the CLI on registration.
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: text("instrument_id")
      .notNull()
      .references(() => instruments.id),
    // The hostname of the machine running the watcher.
    hostname: text("hostname"),
    // OS description (e.g., "Windows 11 23H2").
    osInfo: text("os_info"),
    // Installed watcher package version (PEP 440, e.g. "0.2.0"). Reported on
    // every heartbeat. NULL until a watcher running >= 0.3.0 first checks in.
    watcherVersion: text("watcher_version"),
    // SHA-256 of the last-pushed config YAML.
    configChecksum: text("config_checksum"),
    // The raw YAML text of the watcher's config file, stored verbatim as
    // pushed by the watcher.
    configYaml: text("config_yaml"),
    // Updated on each heartbeat.
    lastHeartbeatAt: timestamp("last_heartbeat_at", {
      withTimezone: true,
      mode: "date",
    }),
    // `stale` is computed at query time when
    // last_heartbeat_at < now() - interval '5 minutes'.
    status: watcherStatusEnum("status").notNull().default("registered"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // Soft-delete marker. NULL means active; non-NULL means deregistered.
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (watcher) => [
    // Partial unique index — at most one active watcher per instrument.
    // Doubles as the lookup index used by getWatcherList / findActiveWatcher.
    uniqueIndex("uq_watchers_active_instrument_id")
      .on(watcher.instrumentId)
      .where(sql`${watcher.deletedAt} is null`),
  ]
);

export const watcherHeartbeats = pgTable(
  "watcher_heartbeats",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    watcherId: uuid("watcher_id")
      .notNull()
      .references(() => watchers.id),
    // Client-reported timestamp.
    timestamp: timestamp("timestamp", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    // Status string from the heartbeat payload (e.g., `watching`, `stopping`).
    status: text("status").notNull(),
    // Included so heartbeat history is interpretable without joining the
    // watcher config.
    uploadMode: uploadModeEnum("upload_mode"),
    filesUploadedSinceLast: integer("files_uploaded_since_last").default(0),
    // Manual mode only.
    runsReportedSinceLast: integer("runs_reported_since_last").default(0),
    errorsSinceLast: integer("errors_since_last").default(0),
    uptimeSeconds: integer("uptime_seconds"),
    // Server-side receive time.
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (heartbeat) => [
    index("idx_watcher_heartbeats_watcher_id_timestamp").on(
      heartbeat.watcherId,
      heartbeat.timestamp.desc()
    ),
  ]
);

export const watcherEvents = pgTable(
  "watcher_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    watcherId: uuid("watcher_id")
      .notNull()
      .references(() => watchers.id),
    eventType: watcherEventTypeEnum("event_type").notNull(),
    // Human-readable summary (e.g., "Uploaded 2026-03-26_experiment.xls to S3").
    message: text("message").notNull(),
    // Structured event data. Shape varies by event_type.
    details: jsonb("details"),
    // Client-reported event time.
    timestamp: timestamp("timestamp", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    // Server-side receive time.
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (event) => [
    index("idx_watcher_events_watcher_id_timestamp").on(
      event.watcherId,
      event.timestamp.desc()
    ),
    index("idx_watcher_events_watcher_id_event_type").on(
      event.watcherId,
      event.eventType
    ),
  ]
);

export const instrumentRuns = pgTable(
  "instrument_runs",
  {
    // Surrogate primary key. The natural key is (instrument_id, run_id).
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: text("instrument_id")
      .notNull()
      .references(() => instruments.id),
    // The run identifier — derived by the Lambda function for auto-mode runs
    // (e.g., filename without extension), or by the watcher's run detection
    // logic for manual-mode runs (e.g., shared prefix, directory name).
    runId: text("run_id").notNull(),
    // How the run was created: `lambda` (auto-created when a file arrives in
    // S3 without a pre-existing run) or `watcher` (reported by the watcher).
    source: instrumentRunSourceEnum("source").notNull().default("lambda"),
    // Set when the run was reported by a watcher. NULL for Lambda-created runs.
    watcherId: uuid("watcher_id").references(() => watchers.id),
    // Run-level metadata, written via
    // PATCH /api/v1/instruments/:instrumentId/runs/:runId. Typically set by
    // the Lambda function after processing all files in a run. Stored as a
    // flat object; multi-valued properties use JSON arrays.
    metadata: jsonb("metadata").notNull().default({}),
    // When the run was first created (reported by watcher or auto-created by
    // Lambda) — i.e. when Data Hub learned about it.
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    // When the run actually happened on the instrument PC, derived by the
    // watcher from the minimum file creation time (st_birthtime where
    // available, else mtime). NULL for Lambda-created runs and runs reported
    // by older watchers; the UI and list queries fall back to created_at.
    acquiredAt: timestamp("acquired_at", {
      withTimezone: true,
      mode: "date",
    }),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // Soft-delete marker. NULL means active; non-NULL means deleted. Queries
    // should filter on this column to exclude deleted runs. Soft-delete is the
    // only delete mode in Data Hub — S3 objects and file rows are never
    // hard-deleted, so a soft-deleted run can always be restored.
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (run) => [
    unique("uq_instrument_runs_instrument_id_run_id").on(
      run.instrumentId,
      run.runId
    ),
    index("idx_instrument_runs_instrument_id_created_at").on(
      run.instrumentId,
      run.createdAt.desc()
    ),
    index("idx_instrument_runs_active")
      .on(run.instrumentId, run.createdAt.desc())
      .where(sql`${run.deletedAt} is null`),
    // Supports the default list sort/filter on coalesce(acquired_at,
    // created_at). Expression must match the buildRunListQuery sort key.
    index("idx_instrument_runs_active_acquired_at")
      .on(
        run.instrumentId,
        sql`coalesce(${run.acquiredAt}, ${run.createdAt}) desc`
      )
      .where(sql`${run.deletedAt} is null`),
    index("idx_instrument_runs_metadata_gin").using("gin", run.metadata),
  ]
);

export const files = pgTable(
  "files",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    instrumentRunId: uuid("instrument_run_id")
      .notNull()
      .references(() => instrumentRuns.id),
    // Path relative to the watcher's watch directory (e.g.,
    // `20260325_data_file_1.csv` or `20260325_testing/data_file_1.csv`). For
    // Lambda-created files this is set to `filename` so both writers dedup
    // against the same `(instrument_run_id, relative_path)` partial unique
    // index. May be NULL for very old rows predating that contract.
    relativePath: text("relative_path"),
    // NULL until the file is uploaded to S3.
    s3Bucket: text("s3_bucket"),
    // NULL until the file is uploaded to S3.
    s3Key: text("s3_key"),
    // Original filename.
    filename: text("filename").notNull(),
    // MIME type.
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    // Distinguishes raw uploads from Lambda-generated artifacts.
    category: fileCategoryEnum("category").notNull().default("raw"),
    // detected → upload_requested → uploaded → processing → completed | failed
    status: fileStatusEnum("status").notNull().default("detected"),
    // Instrument-specific key-value metadata extracted by the Lambda function
    // from this file. Stored as a flat object; multi-valued properties use
    // JSON arrays.
    metadata: jsonb("metadata").notNull().default({}),
    // Human-readable error description if status = 'failed'. NULL otherwise.
    errorMessage: text("error_message"),
    // When the watcher first detected this file on the local filesystem. NULL
    // for Lambda-created files.
    detectedAt: timestamp("detected_at", {
      withTimezone: true,
      mode: "date",
    }),
    // When a user requested upload of this file via the web UI. NULL for
    // auto-mode and Lambda-created files.
    uploadRequestedAt: timestamp("upload_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    // When the file was confirmed uploaded to S3. For Lambda-created files,
    // equals created_at.
    uploadedAt: timestamp("uploaded_at", {
      withTimezone: true,
      mode: "date",
    }),
    // When the Lambda function finished processing this file (regardless of
    // success or failure).
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "date",
    }),
    // On-disk creation time of the file, reported by the watcher
    // (st_birthtime where available, else st_mtime). NULL for
    // Lambda-created files and rows predating this column.
    fileCreatedAt: timestamp("file_created_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    // Per-file soft-delete for dismissing individual files. NULL means active.
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (file) => [
    uniqueIndex("uq_files_instrument_run_id_relative_path")
      .on(file.instrumentRunId, file.relativePath)
      .where(sql`${file.relativePath} is not null`),
    // Shared dedup key between watcher and Lambda writers: filenames are
    // unique per active row within a run. The watcher's request-upload-url
    // already keys lookups on (instrument_run_id, filename); this index
    // enforces uniqueness so the Lambda path cannot insert a parallel row
    // when the watcher has already reported a detected file.
    uniqueIndex("uq_files_active_instrument_run_id_filename")
      .on(file.instrumentRunId, file.filename)
      .where(sql`${file.deletedAt} is null`),
    uniqueIndex("uq_files_s3_key")
      .on(file.s3Key)
      .where(sql`${file.s3Key} is not null`),
    index("idx_files_instrument_run_id").on(file.instrumentRunId),
    index("idx_files_status_instrument_run_id").on(
      file.status,
      file.instrumentRunId
    ),
    // NOTE: A non-unique partial index on (instrument_run_id) WHERE
    // deleted_at IS NULL was previously named `idx_files_active`. It was
    // dropped in migration 0012 because the leading column of
    // `uq_files_active_instrument_run_id_filename` (same predicate) covers
    // the same lookup pattern.
    index("idx_files_upload_queue")
      .on(file.uploadRequestedAt)
      .where(
        sql`${file.uploadRequestedAt} is not null and ${file.uploadedAt} is null and ${file.deletedAt} is null`
      ),
    index("idx_files_metadata_gin").using("gin", file.metadata),
  ]
);

// User-authored markdown notes on a run. Any authenticated user can read
// and create comments; only the author may edit or soft-delete their own
// row (enforced both in the SQL `where` clause and in the route handler).
// Soft-delete via `deletedAt` matches the run/file model so historical
// comments aren't lost. `editedAt` is set on body edits so the UI can
// label edited comments without a separate audit table.
export const runComments = pgTable(
  "run_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => instrumentRuns.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Markdown source. Length-capped at the route layer (10 000 chars) as a
    // cheap guard against abuse; no DB-side limit so we can raise it later
    // without a migration.
    body: text("body").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // Distinct from updatedAt so we can render an "edited" affordance only
    // for body changes (a future column-level edit wouldn't trip this).
    editedAt: timestamp("edited_at", {
      withTimezone: true,
      mode: "date",
    }),
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (comment) => [
    index("idx_run_comments_run_id_created_at").on(
      comment.runId,
      comment.createdAt.desc()
    ),
    index("idx_run_comments_user_id").on(comment.userId),
  ]
);

// Cached run-archive zip builds. Producers (Vercel route + Lambda callback)
// share rows on the partial unique `(instrument_run_id, fingerprint)` index
// while a build is in flight, so two simultaneous "Download all" clicks
// attach to the same job and only invoke the Lambda once. The fingerprint
// is sha256 over the sorted `(file_id, s3_key)` pairs the archive will
// contain, so adding/removing a file produces a fresh job + fresh cached
// object instead of accidentally serving a stale zip.
export const archiveJobs = pgTable(
  "archive_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentRunId: uuid("instrument_run_id")
      .notNull()
      .references(() => instrumentRuns.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    archiveBucket: text("archive_bucket"),
    archiveKey: text("archive_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    status: archiveJobStatusEnum("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    // The user who triggered the build, if invoked via session auth. NULL
    // for token-authenticated callers (MCP, watcher, etc).
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (job) => [
    // At most one in-flight job per (run, fingerprint). Concurrent callers
    // ON CONFLICT DO NOTHING and then SELECT the existing row.
    uniqueIndex("uq_archive_jobs_inflight")
      .on(job.instrumentRunId, job.fingerprint)
      .where(sql`${job.status} in ('pending', 'building')`),
    // Lookup path used by the route's cache check (find an existing ready
    // archive without hitting S3).
    index("idx_archive_jobs_run_fingerprint_status").on(
      job.instrumentRunId,
      job.fingerprint,
      job.status
    ),
  ]
);

// Many-to-many link between users and runs: a user "claims" a run they
// personally performed. Attribution is self-service — users create and remove
// only their own row. Composite PK enforces one row per (run, user).
export const runAttributions = pgTable(
  "run_attributions",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => instrumentRuns.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (attribution) => [
    primaryKey({ columns: [attribution.runId, attribution.userId] }),
    index("idx_run_attributions_run_id").on(attribution.runId),
    index("idx_run_attributions_user_id").on(attribution.userId),
  ]
);
