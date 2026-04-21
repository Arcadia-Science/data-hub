import { parse } from "csv-parse/sync";

import { db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  runAttributions,
  users,
} from "@/lib/db/schema";
import { getS3ObjectStream } from "@/lib/s3";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";

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
export async function lookupRunByNaturalKey(
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
      updatedAt: instrumentRuns.updatedAt,
      deletedAt: instrumentRuns.deletedAt,
      filesPurgedAt: instrumentRuns.filesPurgedAt,
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
  // Either a userId (match runs attributed to that user) or the reserved
  // sentinel "unattributed" (match runs with no attributions).
  ranBy?: string;
};

const UNATTRIBUTED_SENTINEL = "unattributed";

const MAX_PER_PAGE = 100;

const ALLOWED_SORT_FIELDS: Record<
  string,
  (typeof instrumentRuns)["createdAt" | "updatedAt"]
> = {
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

  if (filters.dateFrom) {
    conditions.push(gte(instrumentRuns.createdAt, new Date(filters.dateFrom)));
  }
  // dateTo is a date string (e.g. "2026-03-28") without a time component.
  // Advance by one day so the filter is inclusive of the entire selected day.
  if (filters.dateTo) {
    const end = new Date(filters.dateTo);
    end.setDate(end.getDate() + 1);
    conditions.push(lte(instrumentRuns.createdAt, end));
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
      sql`${instrumentRuns.metadata}->>'wavelength' = ${filters.wavelength}`
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
  // to avoid N+1 queries. All non-deleted files are counted.
  const fileCount = sql<number>`cast(count(${files.id}) filter (where ${files.deletedAt} is null) as int)`;

  const filesCompleted = sql<number>`cast(count(${files.id}) filter (where ${files.status} = 'completed' and ${files.deletedAt} is null) as int)`;

  const filesFailed = sql<number>`cast(count(${files.id}) filter (where ${files.status} = 'failed' and ${files.deletedAt} is null) as int)`;

  // "Pending upload" = files on the instrument PC that haven't reached S3 yet.
  // A non-zero count signals the run has files requiring manual upload action.
  const filesPendingUpload = sql<number>`cast(count(${files.id}) filter (where ${files.status} in ('detected', 'upload_requested') and ${files.deletedAt} is null) as int)`;

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

  const sortCol =
    ALLOWED_SORT_FIELDS[filters.sort ?? "created_at"] ??
    instrumentRuns.createdAt;
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
      updated_at: instrumentRuns.updatedAt,
      deleted_at: instrumentRuns.deletedAt,
      file_count: fileCount,
      files_completed: filesCompleted,
      files_failed: filesFailed,
      files_pending_upload: filesPendingUpload,
      total_size_bytes: totalSizeBytes,
      error_messages: errorMessages,
    })
    .from(instrumentRuns)
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .leftJoin(files, eq(files.instrumentRunId, instrumentRuns.id))
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

// ---------------------------------------------------------------------------
// Per-run file list — all files (including soft-deleted) ordered by creation.
// ---------------------------------------------------------------------------

export async function getRunFiles(runInternalId: string): Promise<RunFile[]> {
  return db
    .select()
    .from(files)
    .where(eq(files.instrumentRunId, runInternalId))
    .orderBy(files.createdAt);
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
  "wavelength",
  "measurement_mode",
  "measurement_type",
  "capture_type",
  "imaging_mode",
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
    distinctMetadataValues(instrumentId, "wavelength"),
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
