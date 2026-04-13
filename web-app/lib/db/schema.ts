import type { AdapterAccountType } from "@auth/core/adapters";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
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
]);

export const uploadModeEnum = pgEnum("upload_mode", ["auto", "manual"]);

export const instrumentRunSourceEnum = pgEnum("instrument_run_source", [
  "lambda",
  "watcher",
]);

export const instrumentTypeEnum = pgEnum("instrument_type", [
  "generic",
  "plate_reader",
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

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (verificationToken) => [
    primaryKey({
      columns: [verificationToken.identifier, verificationToken.token],
    }),
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
  // Suggested glob patterns for the file upload service (e.g., `["*.xls"]`).
  filePatterns: text("file_patterns").array(),
  // The file extension suffix configured on the S3→Lambda trigger (e.g.,
  // `.xls`). Used for validation warnings in the watcher.
  s3TriggerSuffix: text("s3_trigger_suffix"),
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
    index("idx_watchers_instrument_id")
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
    // Lambda).
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
    // Soft-delete marker. NULL means active; non-NULL means deleted. Queries
    // should filter on this column to exclude deleted runs.
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Set by the S3 lifecycle cleanup job when S3 objects for this run have
    // been permanently deleted. NULL means S3 objects are still available. A
    // run with deleted_at set but files_purged_at NULL can still be restored
    // with full data.
    filesPurgedAt: timestamp("files_purged_at", {
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
    // `20260325_data_file_1.csv` or `20260325_testing/data_file_1.csv`). NULL
    // for Lambda-created files (they skip the detection phase).
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
    uniqueIndex("uq_files_s3_key")
      .on(file.s3Key)
      .where(sql`${file.s3Key} is not null`),
    index("idx_files_instrument_run_id").on(file.instrumentRunId),
    index("idx_files_status_instrument_run_id").on(
      file.status,
      file.instrumentRunId
    ),
    index("idx_files_active")
      .on(file.instrumentRunId)
      .where(sql`${file.deletedAt} is null`),
    index("idx_files_upload_queue")
      .on(file.uploadRequestedAt)
      .where(
        sql`${file.uploadRequestedAt} is not null and ${file.uploadedAt} is null and ${file.deletedAt} is null`
      ),
    index("idx_files_metadata_gin").using("gin", file.metadata),
  ]
);

export const runReportData = pgTable(
  "run_report_data",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    instrumentRunId: uuid("instrument_run_id")
      .notNull()
      .references(() => instrumentRuns.id),
    // The source file this data was extracted from. NULL for data produced by
    // run-level analyses (which may aggregate across multiple files).
    fileId: bigint("file_id", { mode: "number" }).references(() => files.id),
    // Identifies the dataset (e.g., `raw_well_data`, `plate_map`,
    // `kinetic_data`, `spectrum_data`, `sample_table`).
    dataType: text("data_type").notNull(),
    // The structured data as a JSON array of row objects.
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (report) => [
    index("idx_run_report_data_instrument_run_id").on(report.instrumentRunId),
    index("idx_run_report_data_file_id").on(report.fileId),
  ]
);
