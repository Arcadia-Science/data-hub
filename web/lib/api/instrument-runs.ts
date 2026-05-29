import { parse } from "csv-parse/sync";

import { formatHinaSizes } from "@/components/runs/run-metadata-badges";
import { db } from "@/lib/db";
import type { InstrumentType } from "@/lib/db/schema";
import {
  files,
  instrumentRuns,
  instruments,
  runAttributions,
  users,
} from "@/lib/db/schema";
import { getS3ObjectStream } from "@/lib/s3";
import type { AnyColumn, SQL } from "drizzle-orm";
import { and, asc, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { cache } from "react";

// ---------------------------------------------------------------------------
// Run attributions: users who claimed they ran a given run. Wire shape is
// deliberately minimal to keep RSC -> client payloads small; `initials` is
// computed server-side so the client doesn't recompute per render.
// ---------------------------------------------------------------------------

export type RunAttribution = {
  userId: string;
  displayName: string;
  initials: string;
  avatarUrl: string | null;
};

function toInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export async function getAttributionsByRunIds(
  runIds: string[]
): Promise<Map<string, RunAttribution[]>> {
  const byRun = new Map<string, RunAttribution[]>();
  if (runIds.length === 0) return byRun;

  const rows = await db
    .select({
      runId: runAttributions.runId,
      userId: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(runAttributions)
    .innerJoin(users, eq(users.id, runAttributions.userId))
    .where(inArray(runAttributions.runId, runIds))
    .orderBy(runAttributions.createdAt);

  for (const row of rows) {
    const displayName = row.name ?? row.email ?? "Unknown";
    const list = byRun.get(row.runId) ?? [];
    list.push({
      userId: row.userId,
      displayName,
      initials: toInitials(displayName),
      avatarUrl: row.image,
    });
    byRun.set(row.runId, list);
  }
  return byRun;
}

// ---------------------------------------------------------------------------
// Run lookup by natural key (instrumentId, runId) — shared across detail,
// patch, delete, and child-resource endpoints.
// ---------------------------------------------------------------------------

// API URLs use human-readable natural keys (e.g., "spectramax-id3-plate-reader"
// + "2026-03-26_experiment") rather than the internal UUID surrogate PK. This
// function resolves that pair to a full run row with the instrument display name.
//
// Wrapped in `cache()` so the run detail page's `generateMetadata` and page
// component share a single DB hit per request (the page calls this once for
// the head and once for the body). Mirrors the same treatment applied to
// `getInstrumentById`.
export const lookupRunByNaturalKey = cache(async function lookupRunByNaturalKey(
  instrumentId: string,
  runId: string
) {
  const decodedRunId = decodeURIComponent(runId);
  const [row] = await db
    .select({
      id: instrumentRuns.id,
      instrumentId: instrumentRuns.instrumentId,
      runId: instrumentRuns.runId,
      source: instrumentRuns.source,
      watcherId: instrumentRuns.watcherId,
      metadata: instrumentRuns.metadata,
      createdAt: instrumentRuns.createdAt,
      acquiredAt: instrumentRuns.acquiredAt,
      updatedAt: instrumentRuns.updatedAt,
      deletedAt: instrumentRuns.deletedAt,
      instrumentDisplayName: instruments.displayName,
      instrumentType: instruments.instrumentType,
    })
    .from(instrumentRuns)
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .where(
      and(
        eq(instrumentRuns.instrumentId, instrumentId),
        eq(instrumentRuns.runId, decodedRunId)
      )
    )
    .limit(1);

  if (!row) return null;

  const byRun = await getAttributionsByRunIds([row.id]);
  return { ...row, attributions: byRun.get(row.id) ?? [] };
});

// ---------------------------------------------------------------------------
// acquired_at parsing for create/update payloads.
//
// Watchers send `acquired_at` as ISO 8601 (UTC) at the run level; older
// watchers (and the lambda) only send per-file `file_created_at` on
// `detected_files[]`. Falling back to min(detected_files.file_created_at)
// gives those callers a usable run-level timestamp without requiring a
// client-side change.
// ---------------------------------------------------------------------------

export function parseAcquiredAt(body: Record<string, unknown>): Date | null {
  if (typeof body.acquired_at === "string") {
    const explicit = new Date(body.acquired_at);
    if (!Number.isNaN(explicit.getTime())) return explicit;
  }

  const detected = Array.isArray(body.detected_files)
    ? body.detected_files
    : [];
  let floor: number | null = null;
  for (const f of detected) {
    if (
      f &&
      typeof f === "object" &&
      "file_created_at" in f &&
      typeof (f as { file_created_at: unknown }).file_created_at === "string"
    ) {
      const t = new Date(
        (f as { file_created_at: string }).file_created_at
      ).getTime();
      if (!Number.isNaN(t) && (floor === null || t < floor)) floor = t;
    }
  }
  return floor === null ? null : new Date(floor);
}

// ---------------------------------------------------------------------------
// Paginated run list with per-run file count aggregation.
// Used by both per-instrument and cross-instrument list endpoints.
// ---------------------------------------------------------------------------

type RunListFilters = {
  instrumentId?: string | string[];
  source?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  sort?: string;
  order?: string;
  page: number;
  perPage: number;
  includeDeleted: boolean;
  wavelength?: string;
  measurementMode?: string;
  measurementType?: string;
  captureType?: string;
  imagingMode?: string;
  gelWavelength?: string;
  gelColor?: string;
  dyeChannel?: string;
  hinaChannel?: string;
  hinaDimension?: string;
  // Raw sizes JSONB object serialized as a string; compared via jsonb equality
  // so key ordering differences between client serialization and stored value
  // don't matter.
  hinaSize?: string;
  // Epson V700 Scanner derived metadata. `dpi` is a numeric string (e.g. "300",
  // "600") and `colorMode` is the canonical "rgb"/"bw" string written by the
  // Lambda's TIFF metadata parser.
  dpi?: string;
  colorMode?: string;
  // Either a userId (match runs attributed to that user) or the reserved
  // sentinel "unattributed" (match runs with no attributions).
  ranBy?: string;
};

const UNATTRIBUTED_SENTINEL = "unattributed";

const MAX_PER_PAGE = 100;

// `acquired_at` sorts on coalesce(acquired_at, created_at) so runs that
// pre-date the watcher backfill, or that came from the lambda (no
// acquired_at), still order alongside watcher-reported runs. The matching
// index is `idx_instrument_runs_active_acquired_at`.
const acquiredOrCreatedSql = sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt})`;

const ALLOWED_SORT_FIELDS: Record<string, SQL | AnyColumn> = {
  acquired_at: acquiredOrCreatedSql,
  created_at: instrumentRuns.createdAt,
  updated_at: instrumentRuns.updatedAt,
};

export async function buildRunListQuery(filters: RunListFilters) {
  const perPage = Math.min(Math.max(filters.perPage, 1), MAX_PER_PAGE);
  const conditions: SQL[] = [];

  if (filters.instrumentId) {
    const ids = Array.isArray(filters.instrumentId)
      ? filters.instrumentId
      : [filters.instrumentId];
    if (ids.length === 1) {
      conditions.push(eq(instrumentRuns.instrumentId, ids[0]));
    } else if (ids.length > 1) {
      conditions.push(inArray(instrumentRuns.instrumentId, ids));
    }
  }

  if (!filters.includeDeleted) {
    conditions.push(isNull(instrumentRuns.deletedAt));
  }

  if (filters.source === "lambda" || filters.source === "watcher") {
    conditions.push(eq(instrumentRuns.source, filters.source));
  }

  // Date filters apply against coalesce(acquired_at, created_at) so a user
  // filtering "runs from yesterday" sees runs whose data was acquired
  // yesterday — even if the watcher only reported them to Data Hub today.
  // Lambda runs and pre-backfill runs (acquired_at IS NULL) fall through to
  // created_at via coalesce.
  //
  // NOTE: drizzle's `gte`/`lte` rely on the column's PgColumn mapper to
  // serialize a JS Date for the postgres-js driver. With a raw SQL
  // fragment as the LHS that mapper is bypassed, so the driver sees a
  // Date and throws ERR_INVALID_ARG_TYPE. Bind ISO strings explicitly and
  // cast on the Postgres side to keep this path on the index.
  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom).toISOString();
    conditions.push(sql`${acquiredOrCreatedSql} >= ${from}::timestamptz`);
  }
  // dateTo is a date string (e.g. "2026-03-28") without a time component.
  // Advance by one day so the filter is inclusive of the entire selected day.
  if (filters.dateTo) {
    const end = new Date(filters.dateTo);
    end.setDate(end.getDate() + 1);
    conditions.push(
      sql`${acquiredOrCreatedSql} <= ${end.toISOString()}::timestamptz`
    );
  }

  if (filters.search) {
    // Escape LIKE wildcards so user input is treated as literal text.
    // TODO: add a pg_trgm GIN index on instrument_runs.run_id for performant ilike
    const escaped = filters.search
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    conditions.push(ilike(instrumentRuns.runId, `%${escaped}%`));
  }

  // Plate-reader metadata column filters (leverages the GIN index).
  if (filters.wavelength) {
    conditions.push(
      sql`${instrumentRuns.metadata}->'wavelengths' @> ${JSON.stringify([filters.wavelength])}::jsonb`
    );
  }
  if (filters.measurementMode) {
    conditions.push(
      sql`${instrumentRuns.metadata}->>'measurement_mode' = ${filters.measurementMode}`
    );
  }
  if (filters.measurementType) {
    conditions.push(
      sql`${instrumentRuns.metadata}->>'measurement_type' = ${filters.measurementType}`
    );
  }

  // Gel-doc metadata column filters (leverages the GIN index).
  if (filters.captureType) {
    conditions.push(
      sql`${instrumentRuns.metadata}->>'capture_type' = ${filters.captureType}`
    );
  }
  if (filters.imagingMode) {
    conditions.push(
      sql`${instrumentRuns.metadata}->>'imaging_mode' = ${filters.imagingMode}`
    );
  }
  if (filters.gelWavelength) {
    conditions.push(
      sql`${instrumentRuns.metadata}->'wavelengths' @> ${JSON.stringify([filters.gelWavelength])}::jsonb`
    );
  }
  if (filters.gelColor) {
    conditions.push(
      sql`${instrumentRuns.metadata}->'colors' @> ${JSON.stringify([filters.gelColor])}::jsonb`
    );
  }

  // qPCR metadata column filters (leverages the GIN index).
  if (filters.dyeChannel) {
    conditions.push(
      sql`${instrumentRuns.metadata}->'dye_channels' @> ${JSON.stringify([filters.dyeChannel])}::jsonb`
    );
  }

  // Hina microscope metadata column filters (leverages the GIN index).
  if (filters.hinaChannel) {
    conditions.push(
      sql`${instrumentRuns.metadata}->'channels' @> ${JSON.stringify([{ name: filters.hinaChannel }])}::jsonb`
    );
  }
  if (filters.hinaDimension) {
    conditions.push(
      sql`${instrumentRuns.metadata}->'dimensions' @> ${JSON.stringify([filters.hinaDimension])}::jsonb`
    );
  }
  if (filters.hinaSize) {
    conditions.push(
      sql`${instrumentRuns.metadata}->'sizes' = ${filters.hinaSize}::jsonb`
    );
  }

  // Epson V700 Scanner metadata column filters. Both use the `->>` text
  // accessor for scalar equality, which is *not* covered by the default
  // jsonb_ops GIN index — these conditions piggyback on
  // `idx_instrument_runs_active(instrument_id, …)` and re-evaluate per row,
  // which is fine on instrument-scoped pages but worth a dedicated
  // expression index if it ever becomes a hot path.
  if (filters.dpi) {
    conditions.push(sql`${instrumentRuns.metadata}->>'dpi' = ${filters.dpi}`);
  }
  if (filters.colorMode) {
    conditions.push(
      sql`${instrumentRuns.metadata}->>'color_mode' = ${filters.colorMode}`
    );
  }

  // Attribution filter — correlated (NOT) EXISTS against run_attributions.
  if (filters.ranBy === UNATTRIBUTED_SENTINEL) {
    conditions.push(
      sql`not exists (select 1 from ${runAttributions} where ${runAttributions.runId} = ${instrumentRuns.id})`
    );
  } else if (filters.ranBy) {
    conditions.push(
      sql`exists (select 1 from ${runAttributions} where ${runAttributions.runId} = ${instrumentRuns.id} and ${runAttributions.userId} = ${filters.ranBy})`
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Single-query aggregation: counts per-run file stats using FILTER (WHERE ...)
  // to avoid N+1 queries. Only raw (instrument-produced) files are counted;
  // processed/derived files are excluded via the LEFT JOIN condition below.
  const fileCount = sql<number>`cast(count(${files.id}) filter (where ${files.deletedAt} is null) as int)`;

  const filesCompleted = sql<number>`cast(count(${files.id}) filter (where ${files.status} = 'completed' and ${files.deletedAt} is null) as int)`;

  const filesFailed = sql<number>`cast(count(${files.id}) filter (where ${files.status} = 'failed' and ${files.deletedAt} is null) as int)`;

  // "Pending upload" = files on the instrument PC that haven't reached S3 yet.
  // A non-zero count signals the run has files requiring manual upload action.
  const filesPendingUpload = sql<number>`cast(count(${files.id}) filter (where ${files.status} in ('detected', 'upload_requested') and ${files.deletedAt} is null) as int)`;

  // "Uploaded" = files in S3 waiting in the processing queue (not yet picked
  // up). Distinct from "Processing" so the UI can show a different state.
  const filesUploaded = sql<number>`cast(count(${files.id}) filter (where ${files.status} = 'uploaded' and ${files.deletedAt} is null) as int)`;

  // "Processing" = files actively being processed server-side.
  const filesProcessing = sql<number>`cast(count(${files.id}) filter (where ${files.status} = 'processing' and ${files.deletedAt} is null) as int)`;

  const totalSizeBytes = sql<number>`cast(coalesce(sum(${files.sizeBytes}) filter (where ${files.deletedAt} is null), 0) as bigint)`;

  const errorMessages = sql<
    string[]
  >`coalesce(array_agg(${files.errorMessage}) filter (where ${files.status} = 'failed' and ${files.errorMessage} is not null and ${files.deletedAt} is null), '{}')`.mapWith(
    {
      mapFromDriverValue: (value: unknown) => {
        if (Array.isArray(value)) return value as string[];
        if (typeof value === "string") {
          if (value === "{}") return [];
          return value
            .replace(/^\{|}$/g, "")
            .split(",")
            .map((s) => s.replace(/^"|"$/g, ""));
        }
        return [];
      },
    }
  );

  // Default sort is the run's actual acquisition time (with fallback to
  // created_at via coalesce inside acquiredOrCreatedSql), so backfilled and
  // freshly-detected runs interleave correctly chronologically.
  const sortCol =
    ALLOWED_SORT_FIELDS[filters.sort ?? "acquired_at"] ?? acquiredOrCreatedSql;
  const orderFn = filters.order === "asc" ? asc : desc;

  // Total count for pagination (runs only, no joins needed for the count).
  const [{ total }] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(instrumentRuns)
    .where(where);

  const totalPages = Math.ceil(total / perPage);
  const offset = (filters.page - 1) * perPage;

  const rows = await db
    .select({
      id: instrumentRuns.id,
      instrument_id: instrumentRuns.instrumentId,
      instrument_display_name: instruments.displayName,
      run_id: instrumentRuns.runId,
      source: instrumentRuns.source,
      metadata: instrumentRuns.metadata,
      created_at: instrumentRuns.createdAt,
      acquired_at: instrumentRuns.acquiredAt,
      updated_at: instrumentRuns.updatedAt,
      deleted_at: instrumentRuns.deletedAt,
      file_count: fileCount,
      files_completed: filesCompleted,
      files_failed: filesFailed,
      files_pending_upload: filesPendingUpload,
      files_uploaded: filesUploaded,
      files_processing: filesProcessing,
      total_size_bytes: totalSizeBytes,
      error_messages: errorMessages,
    })
    .from(instrumentRuns)
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .leftJoin(
      files,
      and(
        eq(files.instrumentRunId, instrumentRuns.id),
        eq(files.category, "raw")
      )
    )
    .where(where)
    .groupBy(instrumentRuns.id, instruments.displayName)
    .orderBy(orderFn(sortCol))
    .limit(perPage)
    .offset(offset);

  // Fetch attributions in a separate query so the join doesn't cross-multiply
  // with the files left-join and break the aggregate counts above.
  const attributionsByRun = await getAttributionsByRunIds(
    rows.map((r) => r.id)
  );
  const data = rows.map((row) => ({
    ...row,
    attributions: attributionsByRun.get(row.id) ?? [],
  }));

  return {
    data,
    pagination: {
      page: filters.page,
      per_page: perPage,
      total,
      total_pages: totalPages,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared types for the run detail page
// ---------------------------------------------------------------------------

export type RunDetail = NonNullable<
  Awaited<ReturnType<typeof lookupRunByNaturalKey>>
>;

export type RunFile = typeof files.$inferSelect;

// Server-truth row shape for the paginated runs list. Derived from
// buildRunListQuery's return type so any column added to the Drizzle
// select (counts, metadata, etc.) automatically flows through to every
// client-side table that renders these rows.
export type RunListRow = Awaited<
  ReturnType<typeof buildRunListQuery>
>["data"][number];

// ---------------------------------------------------------------------------
// Per-run file list — all files (including soft-deleted) ordered by creation.
// ---------------------------------------------------------------------------

// Wrapped in `cache()` so the run detail page's `generateMetadata` (which
// needs the raw-file count) and the page component (which renders the full
// file list) share a single DB hit per request.
export const getRunFiles = cache(async function getRunFiles(
  runInternalId: string
): Promise<RunFile[]> {
  return db
    .select()
    .from(files)
    .where(eq(files.instrumentRunId, runInternalId))
    .orderBy(files.createdAt);
});

// ---------------------------------------------------------------------------
// Per-run file list, paginated. Used by the MCP `list_run_files` tool so that
// runs with thousands of files don't dump every row into a single response.
// Mirrors the page/per_page/total/total_pages shape returned by
// `buildRunListQuery`. Not wrapped in `cache()` — callers pass distinct
// (page, perPage) keys, and the UI uses the unbounded `getRunFiles` above.
// ---------------------------------------------------------------------------

export async function getRunFilesPage(
  runInternalId: string,
  { page, perPage }: { page: number; perPage: number }
): Promise<{
  data: RunFile[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}> {
  const safePerPage = Math.min(Math.max(perPage, 1), MAX_PER_PAGE);
  const safePage = Math.max(page, 1);
  const offset = (safePage - 1) * safePerPage;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(files)
    .where(eq(files.instrumentRunId, runInternalId));

  const data = await db
    .select()
    .from(files)
    .where(eq(files.instrumentRunId, runInternalId))
    .orderBy(files.createdAt)
    .limit(safePerPage)
    .offset(offset);

  return {
    data,
    pagination: {
      page: safePage,
      per_page: safePerPage,
      total,
      total_pages: Math.ceil(total / safePerPage),
    },
  };
}

// ---------------------------------------------------------------------------
// Per-run processed CSV data — fetches CSV files from S3 and parses them.
// ---------------------------------------------------------------------------

export type RawWellRow = Record<string, string>;

async function streamToBuffer(
  stream: import("node:stream").Readable
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getProcessedCsvData(
  runFiles: RunFile[]
): Promise<RawWellRow[]> {
  const csvFiles = runFiles.filter(
    (f) =>
      f.category === "processed" &&
      f.deletedAt === null &&
      f.filename.endsWith(".csv") &&
      f.s3Bucket &&
      f.s3Key
  );

  if (csvFiles.length === 0) return [];

  const results = await Promise.all(
    csvFiles.map(async (file) => {
      try {
        const stream = await getS3ObjectStream(file.s3Bucket!, file.s3Key!);
        const buf = await streamToBuffer(stream);
        return parse(buf, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }) as RawWellRow[];
      } catch (err) {
        console.error(`Failed to fetch processed CSV ${file.s3Key}:`, err);
        return [];
      }
    })
  );

  return results.flat();
}

// ---------------------------------------------------------------------------
// Distinct metadata values for plate-reader column filters.
// ---------------------------------------------------------------------------

export type PlateReaderFilterOptions = {
  wavelengths: string[];
  measurementModes: string[];
  measurementTypes: string[];
};

const ALLOWED_METADATA_KEYS = new Set([
  "measurement_mode",
  "measurement_type",
  "capture_type",
  "imaging_mode",
  "dpi",
  "color_mode",
]);

async function distinctMetadataValues(
  instrumentId: string,
  key: string
): Promise<string[]> {
  if (!ALLOWED_METADATA_KEYS.has(key)) {
    throw new Error(`Invalid metadata key: ${key}`);
  }
  // sql.raw is safe here because key is validated against the allowlist above.
  const jsonKey = sql.raw(`'${key}'`);
  const expr = sql<string>`${instrumentRuns.metadata}->>${jsonKey}`;

  const rows = await db
    .selectDistinct({ value: expr })
    .from(instrumentRuns)
    .where(
      and(
        eq(instrumentRuns.instrumentId, instrumentId),
        isNull(instrumentRuns.deletedAt),
        sql`${expr} is not null`
      )
    )
    .orderBy(expr);

  return rows.map((r) => r.value).filter(Boolean);
}

export async function getPlateReaderFilterOptions(
  instrumentId: string
): Promise<PlateReaderFilterOptions> {
  const [wavelengths, measurementModes, measurementTypes] = await Promise.all([
    distinctMetadataArrayValues(instrumentId, "wavelengths"),
    distinctMetadataValues(instrumentId, "measurement_mode"),
    distinctMetadataValues(instrumentId, "measurement_type"),
  ]);
  return { wavelengths, measurementModes, measurementTypes };
}

// ---------------------------------------------------------------------------
// Distinct metadata values for gel-doc column filters.
// ---------------------------------------------------------------------------

export type GelDocFilterOptions = {
  captureTypes: string[];
  imagingModes: string[];
  wavelengths: string[];
  colors: string[];
};

const ALLOWED_METADATA_ARRAY_KEYS = new Set([
  "wavelengths",
  "colors",
  "dye_channels",
  "dimensions",
]);

async function distinctMetadataArrayValues(
  instrumentId: string,
  key: string
): Promise<string[]> {
  if (!ALLOWED_METADATA_ARRAY_KEYS.has(key)) {
    throw new Error(`Invalid metadata array key: ${key}`);
  }
  const jsonKey = sql.raw(`'${key}'`);
  const rows = await db.execute<{ value: string }>(
    sql`select distinct val as value
        from ${instrumentRuns},
             lateral jsonb_array_elements_text(${instrumentRuns.metadata}->${jsonKey}) as val
        where ${instrumentRuns.instrumentId} = ${instrumentId}
          and ${instrumentRuns.deletedAt} is null
          and jsonb_typeof(${instrumentRuns.metadata}->${jsonKey}) = 'array'
        order by val`
  );
  return Array.from(rows, (r) => r.value).filter(Boolean);
}

export async function getGelDocFilterOptions(
  instrumentId: string
): Promise<GelDocFilterOptions> {
  const [captureTypes, imagingModes, wavelengths, colors] = await Promise.all([
    distinctMetadataValues(instrumentId, "capture_type"),
    distinctMetadataValues(instrumentId, "imaging_mode"),
    distinctMetadataArrayValues(instrumentId, "wavelengths"),
    distinctMetadataArrayValues(instrumentId, "colors"),
  ]);
  return { captureTypes, imagingModes, wavelengths, colors };
}

// ---------------------------------------------------------------------------
// Distinct metadata values for qPCR column filters.
// ---------------------------------------------------------------------------

export type QpcrFilterOptions = {
  dyeChannels: string[];
};

export async function getQpcrFilterOptions(
  instrumentId: string
): Promise<QpcrFilterOptions> {
  const dyeChannels = await distinctMetadataArrayValues(
    instrumentId,
    "dye_channels"
  );
  return { dyeChannels };
}

// ---------------------------------------------------------------------------
// Distinct metadata values for Hina microscope column filters.
// ---------------------------------------------------------------------------

// Sizes are stored as a JSONB object keyed by dimension (e.g.
// `{"C":4,"X":256,"Y":256}`). We return the raw jsonb object for equality
// filtering together with a pre-formatted label so the client doesn't need to
// reimplement the formatting rules.
export type HinaSizeOption = { value: string; label: string };

export type HinaFilterOptions = {
  channels: string[];
  dimensions: string[];
  sizes: HinaSizeOption[];
};

async function distinctHinaChannelNames(
  instrumentId: string
): Promise<string[]> {
  const rows = await db.execute<{ value: string }>(
    sql`select distinct elem->>'name' as value
        from ${instrumentRuns},
             lateral jsonb_array_elements(${instrumentRuns.metadata}->'channels') as elem
        where ${instrumentRuns.instrumentId} = ${instrumentId}
          and ${instrumentRuns.deletedAt} is null
          and jsonb_typeof(${instrumentRuns.metadata}->'channels') = 'array'
          and elem->>'name' is not null
        order by value`
  );
  return Array.from(rows, (r) => r.value).filter(Boolean);
}

async function distinctHinaSizeObjects(
  instrumentId: string
): Promise<Record<string, unknown>[]> {
  const rows = await db.execute<{ value: Record<string, unknown> }>(
    sql`select distinct ${instrumentRuns.metadata}->'sizes' as value
        from ${instrumentRuns}
        where ${instrumentRuns.instrumentId} = ${instrumentId}
          and ${instrumentRuns.deletedAt} is null
          and jsonb_typeof(${instrumentRuns.metadata}->'sizes') = 'object'`
  );
  return Array.from(rows, (r) => r.value).filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === "object"
  );
}

export async function getHinaFilterOptions(
  instrumentId: string
): Promise<HinaFilterOptions> {
  const [channels, dimensions, sizeObjects] = await Promise.all([
    distinctHinaChannelNames(instrumentId),
    distinctMetadataArrayValues(instrumentId, "dimensions"),
    distinctHinaSizeObjects(instrumentId),
  ]);

  const sizes = sizeObjects
    .map((obj) => ({
      value: JSON.stringify(obj),
      label: formatHinaSizes(obj),
    }))
    .filter((s) => s.label.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));

  return { channels, dimensions, sizes };
}

// ---------------------------------------------------------------------------
// Distinct metadata values for Epson V700 Scanner column filters.
// ---------------------------------------------------------------------------

export type EpsonScannerFilterOptions = {
  dpis: string[];
  colorModes: string[];
};

export async function getEpsonScannerFilterOptions(
  instrumentId: string
): Promise<EpsonScannerFilterOptions> {
  const [dpis, colorModes] = await Promise.all([
    distinctMetadataValues(instrumentId, "dpi"),
    distinctMetadataValues(instrumentId, "color_mode"),
  ]);
  return { dpis, colorModes };
}

// ---------------------------------------------------------------------------
// Dispatcher: fetch whichever per-instrument filter options apply to this
// instrument type. The discriminated return shape lets the caller narrow to
// the correct variant component without non-null assertions, and TS
// exhaustiveness-checks the switch so a newly added `InstrumentType` won't
// compile until it's handled here.
// ---------------------------------------------------------------------------

export type InstrumentFilterOptionsByType =
  | { kind: "plate_reader"; options: PlateReaderFilterOptions }
  | { kind: "gel_doc"; options: GelDocFilterOptions }
  | { kind: "qpcr"; options: QpcrFilterOptions }
  | { kind: "hina_microscope"; options: HinaFilterOptions }
  | { kind: "epson_v700_scanner"; options: EpsonScannerFilterOptions }
  | { kind: "default" };

export async function getInstrumentFilterOptions(
  instrumentType: InstrumentType,
  instrumentId: string
): Promise<InstrumentFilterOptionsByType> {
  switch (instrumentType) {
    case "plate_reader":
      return {
        kind: "plate_reader",
        options: await getPlateReaderFilterOptions(instrumentId),
      };
    case "gel_doc":
      return {
        kind: "gel_doc",
        options: await getGelDocFilterOptions(instrumentId),
      };
    case "qpcr":
      return {
        kind: "qpcr",
        options: await getQpcrFilterOptions(instrumentId),
      };
    case "hina_microscope":
      return {
        kind: "hina_microscope",
        options: await getHinaFilterOptions(instrumentId),
      };
    case "epson_v700_scanner":
      return {
        kind: "epson_v700_scanner",
        options: await getEpsonScannerFilterOptions(instrumentId),
      };
    case "generic":
    case "tape_station":
    case "instant_raman":
      return { kind: "default" };
  }
}

// ---------------------------------------------------------------------------
// Distinct users who have attributed any (non-deleted) run for this
// instrument — used to populate the "Ran By" column filter dropdown.
// ---------------------------------------------------------------------------

export type RanByFilterOption = {
  userId: string;
  displayName: string;
};

export async function getRanByFilterOptions(
  instrumentId: string
): Promise<RanByFilterOption[]> {
  const rows = await db
    .selectDistinct({
      userId: users.id,
      name: users.name,
      email: users.email,
    })
    .from(runAttributions)
    .innerJoin(users, eq(users.id, runAttributions.userId))
    .innerJoin(instrumentRuns, eq(instrumentRuns.id, runAttributions.runId))
    .where(
      and(
        eq(instrumentRuns.instrumentId, instrumentId),
        isNull(instrumentRuns.deletedAt)
      )
    )
    .orderBy(users.name);

  return rows.map((r) => ({
    userId: r.userId,
    displayName: r.name ?? r.email ?? "Unknown",
  }));
}
