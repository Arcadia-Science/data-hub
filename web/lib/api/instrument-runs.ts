import { parse as parseCsvStream } from "csv-parse";
import { parse } from "csv-parse/sync";
import type { AnyColumn, SQL } from "drizzle-orm";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { cache } from "react";
import { formatHinaSizes } from "@/components/runs/run-metadata-badges";
import { escapeLikePattern } from "@/lib/api/like-pattern";
import { db } from "@/lib/db";
import type { InstrumentType } from "@/lib/db/schema";
import {
  files,
  instrumentRuns,
  instruments,
  runAttributions,
  users,
} from "@/lib/db/schema";
import type { RunStatus } from "@/lib/runs/run-status";
import { getS3ObjectStream } from "@/lib/s3";

// ---------------------------------------------------------------------------
// Run attributions: users who claimed they ran a given run. Wire shape is
// deliberately minimal to keep RSC -> client payloads small; `initials` is
// computed server-side so the client doesn't recompute per render.
// ---------------------------------------------------------------------------

export interface RunAttribution {
  avatarUrl: string | null;
  displayName: string;
  initials: string;
  userId: string;
}

// The user who soft-deleted a run, resolved for display in the run header's
// deleted banner. Shares the shape of `RunAttribution` so the header can
// render it with the same avatar/initials treatment.
export interface RunDeleter {
  avatarUrl: string | null;
  displayName: string;
  initials: string;
  userId: string;
}

function toInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts.at(-1)?.[0]).toUpperCase();
}

export async function getAttributionsByRunIds(
  runIds: string[]
): Promise<Map<string, RunAttribution[]>> {
  const byRun = new Map<string, RunAttribution[]>();
  if (runIds.length === 0) {
    return byRun;
  }

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
      deletedBy: instrumentRuns.deletedBy,
      instrumentDisplayName: instruments.displayName,
      instrumentType: instruments.instrumentType,
      // Deleter identity, resolved via the left join below. All NULL when the
      // run is active or was deleted before `deleted_by` was captured.
      deletedByName: users.name,
      deletedByEmail: users.email,
      deletedByImage: users.image,
    })
    .from(instrumentRuns)
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .leftJoin(users, eq(users.id, instrumentRuns.deletedBy))
    .where(
      and(
        eq(instrumentRuns.instrumentId, instrumentId),
        eq(instrumentRuns.runId, decodedRunId)
      )
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const { deletedByName, deletedByEmail, deletedByImage, ...runRow } = row;

  // Collapse the three nullable user columns into one object the header can
  // render directly. Email is the fallback label for users without a name.
  const deletedByUser: RunDeleter | null = runRow.deletedBy
    ? {
        userId: runRow.deletedBy,
        displayName: deletedByName ?? deletedByEmail ?? "Unknown user",
        initials: toInitials(deletedByName ?? deletedByEmail ?? "Unknown user"),
        avatarUrl: deletedByImage,
      }
    : null;

  const byRun = await getAttributionsByRunIds([runRow.id]);
  return {
    ...runRow,
    deletedByUser,
    attributions: byRun.get(runRow.id) ?? [],
  };
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
    if (!Number.isNaN(explicit.getTime())) {
      return explicit;
    }
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
      if (!Number.isNaN(t) && (floor === null || t < floor)) {
        floor = t;
      }
    }
  }
  return floor === null ? null : new Date(floor);
}

// ---------------------------------------------------------------------------
// Paginated run list with per-run file count aggregation.
// Used by both per-instrument and cross-instrument list endpoints.
// ---------------------------------------------------------------------------

import type { RunMetadataFilterArgs } from "@/lib/api/run-metadata-filters";

interface RunListFilters extends RunMetadataFilterArgs {
  dateFrom?: string;
  dateTo?: string;
  includeDeleted: boolean;
  instrumentId?: string | string[];
  order?: string;
  page: number;
  perPage: number;
  // Either a userId (match runs attributed to that user) or the reserved
  // sentinel "unattributed" (match runs with no attributions).
  ranBy?: string;
  search?: string;
  sort?: string;
  source?: string;
  // Derived run statuses to match (OR'd together). Undefined/empty = no filter.
  statuses?: RunStatus[];
}

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

// Mirrors the aggregate LEFT JOIN's scope so the filter matches the shown icon.
const rawFileScopeSql = sql`${files.instrumentRunId} = ${instrumentRuns.id} and ${files.category} = 'raw' and ${files.deletedAt} is null`;

function existsRawFileWithStatus(statusSql: SQL): SQL {
  return sql`exists (select 1 from ${files} where ${rawFileScopeSql} and ${statusSql})`;
}

// Priority-exclusive (NOT) EXISTS predicate per derived status, mirroring
// `deriveRunStatus`. Correlated subqueries (not a HAVING over the aggregate)
// keep the pagination COUNT off a `files` join and on the status/run indexes.
function runStatusCondition(status: RunStatus): SQL {
  const failed = existsRawFileWithStatus(sql`${files.status} = 'failed'`);
  const pending = existsRawFileWithStatus(
    sql`${files.status} in ('detected', 'upload_requested')`
  );
  const uploaded = existsRawFileWithStatus(sql`${files.status} = 'uploaded'`);
  const processing = existsRawFileWithStatus(
    sql`${files.status} = 'processing'`
  );
  const completed = existsRawFileWithStatus(sql`${files.status} = 'completed'`);

  switch (status) {
    case "failed":
      return failed;
    case "pending":
      return sql`(not ${failed} and ${pending})`;
    case "uploaded":
      return sql`(not ${failed} and not ${pending} and ${uploaded})`;
    case "processing":
      return sql`(not ${failed} and not ${pending} and not ${uploaded} and ${processing})`;
    case "completed":
      return sql`(not ${failed} and not ${pending} and not ${uploaded} and not ${processing} and ${completed})`;
    default:
      return sql`not exists (select 1 from ${files} where ${rawFileScopeSql})`;
  }
}

// ---------------------------------------------------------------------------
// Adjacent-run navigation for the run detail header.
// ---------------------------------------------------------------------------

// Resolves the runs immediately newer (`previousRunId`) and older
// (`nextRunId`) than `current` within the same instrument, matching the runs
// table's `coalesce(acquired_at, created_at) DESC` ordering. The `id` tiebreak
// keeps neighbors deterministic when two runs share a timestamp; the list
// query has no tiebreak, so equal-timestamp ordering is otherwise arbitrary.
// Deleted runs are excluded to mirror the table's default. Wrapped in `cache()`
// like `lookupRunByNaturalKey` so a single request reuses the result.
export const getAdjacentRunIds = cache(
  async function getAdjacentRunIds(current: {
    acquiredAt: Date | null;
    createdAt: Date;
    id: string;
    instrumentId: string;
  }): Promise<{ nextRunId: string | null; previousRunId: string | null }> {
    const cur = (current.acquiredAt ?? current.createdAt).toISOString();
    const inSameInstrument = and(
      eq(instrumentRuns.instrumentId, current.instrumentId),
      isNull(instrumentRuns.deletedAt)
    );

    const [previous, next] = await Promise.all([
      // Newer neighbor: smallest sort value strictly greater than current.
      db
        .select({ runId: instrumentRuns.runId })
        .from(instrumentRuns)
        .where(
          and(
            inSameInstrument,
            sql`(${acquiredOrCreatedSql} > ${cur}::timestamptz or (${acquiredOrCreatedSql} = ${cur}::timestamptz and ${instrumentRuns.id} > ${current.id}))`
          )
        )
        .orderBy(asc(acquiredOrCreatedSql), asc(instrumentRuns.id))
        .limit(1),
      // Older neighbor: greatest sort value strictly less than current.
      db
        .select({ runId: instrumentRuns.runId })
        .from(instrumentRuns)
        .where(
          and(
            inSameInstrument,
            sql`(${acquiredOrCreatedSql} < ${cur}::timestamptz or (${acquiredOrCreatedSql} = ${cur}::timestamptz and ${instrumentRuns.id} < ${current.id}))`
          )
        )
        .orderBy(desc(acquiredOrCreatedSql), desc(instrumentRuns.id))
        .limit(1),
    ]);

    return {
      previousRunId: previous[0]?.runId ?? null,
      nextRunId: next[0]?.runId ?? null,
    };
  }
);

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
  // NOTE: a raw SQL fragment as the LHS bypasses the column's PgColumn
  // mapper, so an interpolated JS Date reaches the driver with no Postgres
  // type to bind against. Bind ISO strings explicitly and cast to
  // timestamptz so the comparison stays correctly typed and on the index.
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

  if (filters.statuses && filters.statuses.length > 0) {
    const statusOr = or(...filters.statuses.map(runStatusCondition));
    if (statusOr) {
      conditions.push(statusOr);
    }
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
        if (Array.isArray(value)) {
          return value as string[];
        }
        if (typeof value === "string") {
          if (value === "{}") {
            return [];
          }
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
      instrument_type: instruments.instrumentType,
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
    .groupBy(
      instrumentRuns.id,
      instruments.displayName,
      instruments.instrumentType
    )
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
// Per-run file list — server-side filtering, sorting, and pagination for the
// run detail files table. The web UI is URL-driven (nuqs) and only ever
// fetches a single page, so runs with thousands of files never load the whole
// list into memory.
// ---------------------------------------------------------------------------

// Mirrors the client-side filter/sort unions the files table exposes.
// Category (raw/processed) and lifecycle status are independent multi-selects.
export type FilesCategoryFilter = "raw" | "processed";

export type FilesLifecycleFilter =
  | "pending"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed";

export type FilesSortField = "name" | "size" | "date" | "status";

// Filter inputs shared by the paginated query and the archive-download
// "download what you filtered" resolution. Empty arrays mean "no filter".
export interface RunFilesFilter {
  categories?: FilesCategoryFilter[];
  includeDismissed?: boolean;
  search?: string;
  statuses?: FilesLifecycleFilter[];
}

export type RunFilesListFilters = RunFilesFilter & {
  page: number;
  perPage: number;
  sort?: FilesSortField;
};

// "Pending" in the UI collapses the two pre-upload statuses.
const PENDING_FILE_STATUSES = ["detected", "upload_requested"] as const;

// Status-label sort order. Mirrors the alphabetical ordering produced by the
// client's `statusLabel` localeCompare (Completed, Dismissed, Failed, Pending,
// Processing, Uploaded, Uploading) so server-side sort matches what the table
// rendered before. Dismissed (soft-deleted) rows rank by their label too.
const statusSortRank = sql`case
  when ${files.deletedAt} is not null then 2
  when ${files.status} = 'completed' then 1
  when ${files.status} = 'failed' then 3
  when ${files.status} = 'detected' then 4
  when ${files.status} = 'processing' then 5
  when ${files.status} = 'uploaded' then 6
  when ${files.status} = 'upload_requested' then 7
  else 8
end`;

// Build the WHERE conditions for a run's file list. Exported so the archive
// route can resolve the same filtered set the table is showing.
export function runFilesWhere(
  runInternalId: string,
  filters: RunFilesFilter
): SQL[] {
  const conditions: SQL[] = [eq(files.instrumentRunId, runInternalId)];

  if (!filters.includeDismissed) {
    conditions.push(isNull(files.deletedAt));
  }

  if (filters.search) {
    conditions.push(
      ilike(files.filename, `%${escapeLikePattern(filters.search)}%`)
    );
  }

  if (filters.categories && filters.categories.length > 0) {
    conditions.push(inArray(files.category, filters.categories));
  }

  if (filters.statuses && filters.statuses.length > 0) {
    // OR within the status multi-select; "pending" expands to the two
    // pre-upload DB statuses collapsed into one UI option.
    const statusPredicates = filters.statuses.map((status) =>
      status === "pending"
        ? inArray(files.status, [...PENDING_FILE_STATUSES])
        : eq(files.status, status)
    );
    const statusOr = or(...statusPredicates);
    if (statusOr) {
      conditions.push(statusOr);
    }
  }

  return conditions;
}

// Category-first ordering (raw before processed, matching the old
// `compareByCategory`) then the chosen field. Date sorts on
// coalesce(file_created_at, created_at) to match the displayed "Created"
// column; size coalesces NULL to 0 like the old numeric comparator.
function runFilesOrderBy(sort: FilesSortField): SQL[] {
  const categoryFirst = sql`(${files.category} = 'raw') desc`;
  switch (sort) {
    case "size":
      return [categoryFirst, sql`coalesce(${files.sizeBytes}, 0) asc`];
    case "date":
      return [
        categoryFirst,
        sql`coalesce(${files.fileCreatedAt}, ${files.createdAt}) asc`,
      ];
    case "status":
      return [categoryFirst, sql`${statusSortRank} asc`];
    default:
      return [categoryFirst, sql`${files.filename} asc`];
  }
}

export interface RunFilesPage {
  data: RunFile[];
  // Files in the current filter that have S3 keys and can be zipped by the
  // archive route (matches `loadDownloadableFiles` after id resolution).
  downloadableCount: number;
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

export async function buildRunFilesQuery(
  runInternalId: string,
  filters: RunFilesListFilters
): Promise<RunFilesPage> {
  const safePerPage = Math.min(Math.max(filters.perPage, 1), MAX_PER_PAGE);
  const safePage = Math.max(filters.page, 1);
  const offset = (safePage - 1) * safePerPage;

  const where = and(...runFilesWhere(runInternalId, filters));

  const [{ total, downloadableCount }] = await db
    .select({
      total: sql<number>`cast(count(*) as int)`,
      downloadableCount: sql<number>`cast(count(*) filter (where ${files.s3Bucket} is not null and ${files.s3Key} is not null and ${files.deletedAt} is null) as int)`,
    })
    .from(files)
    .where(where);

  const data = await db
    .select()
    .from(files)
    .where(where)
    .orderBy(...runFilesOrderBy(filters.sort ?? "name"))
    .limit(safePerPage)
    .offset(offset);

  return {
    data,
    downloadableCount,
    pagination: {
      page: safePage,
      per_page: safePerPage,
      total,
      total_pages: Math.ceil(total / safePerPage),
    },
  };
}

// Aggregate per-run file counts in a single query. Replaces the client-side
// summary counting that used to scan the full file list, and feeds the table
// footer, the in-flight auto-refresh signal, the per-variant counts, and the
// run detail page's `generateMetadata`.
export interface RunFileStats {
  active: number;
  // Files awaiting an upload request (status = detected).
  detected: number;
  dismissed: number;
  failed: number;
  pending: number;
  processedActive: number;
  processing: number;
  rawActive: number;
  // Sum of raw-file `size_bytes` only — mirrors the runs-table Size column.
  rawTotalSizeBytes: number;
  uploaded: number;
  // Files actively uploading to S3 (status = upload_requested). Tracked
  // separately from `pending` so the table only auto-refreshes while work is
  // genuinely in flight (not while files merely await a manual upload).
  uploadRequested: number;
}

export async function getRunFileStats(
  runInternalId: string
): Promise<RunFileStats> {
  const activeNotDeleted = sql`${files.deletedAt} is null`;
  const rawActiveNotDeleted = sql`${files.category} = 'raw' and ${activeNotDeleted}`;
  const [row] = await db
    .select({
      active: sql<number>`cast(count(*) filter (where ${activeNotDeleted}) as int)`,
      dismissed: sql<number>`cast(count(*) filter (where ${files.deletedAt} is not null) as int)`,
      rawActive: sql<number>`cast(count(*) filter (where ${rawActiveNotDeleted}) as int)`,
      // bigint can arrive as a string from node-pg; Number() at the boundary.
      rawTotalSizeBytes: sql<
        number | string
      >`cast(coalesce(sum(${files.sizeBytes}) filter (where ${rawActiveNotDeleted}), 0) as bigint)`,
      processedActive: sql<number>`cast(count(*) filter (where ${files.category} = 'processed' and ${activeNotDeleted}) as int)`,
      detected: sql<number>`cast(count(*) filter (where ${files.status} = 'detected' and ${activeNotDeleted}) as int)`,
      failed: sql<number>`cast(count(*) filter (where ${files.status} = 'failed' and ${activeNotDeleted}) as int)`,
      pending: sql<number>`cast(count(*) filter (where ${files.status} in ('detected', 'upload_requested') and ${activeNotDeleted}) as int)`,
      uploaded: sql<number>`cast(count(*) filter (where ${files.status} not in ('detected', 'upload_requested', 'processing') and ${activeNotDeleted}) as int)`,
      processing: sql<number>`cast(count(*) filter (where ${files.status} = 'processing' and ${activeNotDeleted}) as int)`,
      uploadRequested: sql<number>`cast(count(*) filter (where ${files.status} = 'upload_requested' and ${activeNotDeleted}) as int)`,
    })
    .from(files)
    .where(eq(files.instrumentRunId, runInternalId));

  return {
    ...row,
    rawTotalSizeBytes: Number(row.rawTotalSizeBytes),
  };
}

// Report-relevant files for a run: processed artifacts, any PDFs, and any
// CSVs. The report sections render these inline (processed images, CSV
// tables, PDF previews); `getProcessedCsvData` parses the processed CSVs; and
// the InstantRaman variant treats every active CSV (raw or processed) as a
// spectrum. CSVs/PDFs are matched by content type or extension so raw uploads
// are included. Scoped to report-relevant outputs (typically few) rather than
// the thousands of raw files that motivated server-side pagination.
export async function getRunReportFiles(
  runInternalId: string
): Promise<RunFile[]> {
  return await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, runInternalId),
        isNull(files.deletedAt),
        sql`(
          ${files.category} = 'processed'
          or ${files.contentType} in ('application/pdf', 'text/csv')
          or lower(${files.filename}) like '%.pdf'
          or lower(${files.filename}) like '%.csv'
        )`
      )
    )
    .orderBy(files.createdAt);
}

// An MCP run report is a digest, not a file listing — cap the payload.
const REPORT_IMAGE_LIMIT = 100;

// Images for the MCP run report — raw captures included, processed first so
// they survive the cap. The web viewer uses `getReportItemsPage` instead.
export async function getRunImageFiles(
  runInternalId: string
): Promise<RunFile[]> {
  return await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, runInternalId),
        isNull(files.deletedAt),
        // Only images already in S3 have bytes to render; skip ones still
        // pending upload so the report never links a broken image.
        sql`${files.s3Bucket} is not null and ${files.s3Key} is not null`,
        sql`(
          ${files.contentType} in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
          or lower(${files.filename}) like '%.png'
          or lower(${files.filename}) like '%.jpg'
          or lower(${files.filename}) like '%.jpeg'
          or lower(${files.filename}) like '%.gif'
          or lower(${files.filename}) like '%.webp'
        )`
      )
    )
    .orderBy(sql`(${files.category} = 'processed') desc`, files.filename)
    .limit(REPORT_IMAGE_LIMIT);
}

// Resolve the file IDs matching the current table filters, used by the
// archive route so "Download all" honors active filters across every page.
export async function getFilteredFileIds(
  runInternalId: string,
  filters: RunFilesFilter
): Promise<number[]> {
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(and(...runFilesWhere(runInternalId, filters)));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Per-run file list, paginated. Used by the MCP `list_run_files` tool so that
// runs with thousands of files don't dump every row into a single response.
// Mirrors the page/per_page/total/total_pages shape returned by
// `buildRunListQuery`. Not wrapped in `cache()` — callers pass distinct
// (page, perPage) keys.
// ---------------------------------------------------------------------------

export async function getRunFilesPage(
  runInternalId: string,
  {
    page,
    perPage,
    statuses,
  }: {
    page: number;
    perPage: number;
    statuses?: RunFile["status"][];
  }
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

  const where =
    statuses && statuses.length > 0
      ? and(
          eq(files.instrumentRunId, runInternalId),
          inArray(files.status, statuses)
        )
      : eq(files.instrumentRunId, runInternalId);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(files)
    .where(where);

  const data = await db
    .select()
    .from(files)
    .where(where)
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

  if (csvFiles.length === 0) {
    return [];
  }

  const results = await Promise.all(
    csvFiles.map(async (file) => {
      const { s3Bucket, s3Key } = file;
      if (!(s3Bucket && s3Key)) {
        return [];
      }
      try {
        const stream = await getS3ObjectStream(s3Bucket, s3Key);
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

export interface ProcessedCsvSummary {
  columns: string[];
  rowCount: number;
  sampleRows: RawWellRow[];
  // True when `scanLimit` was hit and reading stopped early, so `rowCount` is
  // a floor rather than the exact total.
  truncated: boolean;
}

// Streaming counterpart to `getProcessedCsvData` for report/summary callers.
// Streams each CSV row-by-row and retains only up to `sampleLimit` rows, so
// peak memory stays bounded by the sample rather than the full plate grid(s).
// Reading also stops once `scanLimit` rows have been seen, bounding wall-clock
// cost (and download bytes) so a pathological multi-CSV run can't blow the
// MCP route's request budget just to compute a total.
export async function getProcessedCsvSummary(
  runFiles: RunFile[],
  sampleLimit: number,
  scanLimit: number
): Promise<ProcessedCsvSummary> {
  const csvFiles = runFiles.filter(
    (f) =>
      f.category === "processed" &&
      f.deletedAt === null &&
      f.filename.endsWith(".csv") &&
      f.s3Bucket &&
      f.s3Key
  );

  const sampleRows: RawWellRow[] = [];
  let rowCount = 0;
  let truncated = false;

  for (const file of csvFiles) {
    if (truncated) {
      break;
    }
    const { s3Bucket, s3Key } = file;
    if (!(s3Bucket && s3Key)) {
      continue;
    }
    let stream: import("node:stream").Readable | undefined;
    try {
      stream = await getS3ObjectStream(s3Bucket, s3Key);
      const parser = stream.pipe(
        parseCsvStream({ columns: true, skip_empty_lines: true, trim: true })
      );
      for await (const record of parser) {
        rowCount++;
        if (sampleRows.length < sampleLimit) {
          sampleRows.push(record as RawWellRow);
        }
        if (rowCount >= scanLimit) {
          truncated = true;
          break;
        }
      }
    } catch (err) {
      // Mirror `getProcessedCsvData`: a bad CSV is skipped, not fatal. Rows
      // read before a mid-stream error still count toward the summary.
      console.error(`Failed to fetch processed CSV ${s3Key}:`, err);
    } finally {
      // Breaking the for-await destroys the parser but not the piped source,
      // so destroy it explicitly to stop downloading the rest of the object.
      stream?.destroy();
    }
  }

  const columns =
    sampleRows.length > 0 ? Object.keys(sampleRows[0]).sort() : [];

  return { columns, rowCount, sampleRows, truncated };
}

// ---------------------------------------------------------------------------
// Distinct metadata values for plate-reader column filters.
// ---------------------------------------------------------------------------

export interface PlateReaderFilterOptions {
  measurementModes: string[];
  measurementTypes: string[];
  wavelengths: string[];
}

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

export interface GelDocFilterOptions {
  captureTypes: string[];
  colors: string[];
  imagingModes: string[];
  wavelengths: string[];
}

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
  const result = await db.execute<{ value: string }>(
    sql`select distinct val as value
        from ${instrumentRuns},
             lateral jsonb_array_elements_text(${instrumentRuns.metadata}->${jsonKey}) as val
        where ${instrumentRuns.instrumentId} = ${instrumentId}
          and ${instrumentRuns.deletedAt} is null
          and jsonb_typeof(${instrumentRuns.metadata}->${jsonKey}) = 'array'
        order by val`
  );
  return Array.from(result.rows, (r) => r.value).filter(Boolean);
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

export interface QpcrFilterOptions {
  dyeChannels: string[];
}

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
export interface HinaSizeOption {
  label: string;
  value: string;
}

export interface HinaFilterOptions {
  channels: string[];
  dimensions: string[];
  sizes: HinaSizeOption[];
}

async function distinctHinaChannelNames(
  instrumentId: string
): Promise<string[]> {
  const result = await db.execute<{ value: string }>(
    sql`select distinct elem->>'name' as value
        from ${instrumentRuns},
             lateral jsonb_array_elements(${instrumentRuns.metadata}->'channels') as elem
        where ${instrumentRuns.instrumentId} = ${instrumentId}
          and ${instrumentRuns.deletedAt} is null
          and jsonb_typeof(${instrumentRuns.metadata}->'channels') = 'array'
          and elem->>'name' is not null
        order by value`
  );
  return Array.from(result.rows, (r) => r.value).filter(Boolean);
}

async function distinctHinaSizeObjects(
  instrumentId: string
): Promise<Record<string, unknown>[]> {
  const result = await db.execute<{ value: Record<string, unknown> }>(
    sql`select distinct ${instrumentRuns.metadata}->'sizes' as value
        from ${instrumentRuns}
        where ${instrumentRuns.instrumentId} = ${instrumentId}
          and ${instrumentRuns.deletedAt} is null
          and jsonb_typeof(${instrumentRuns.metadata}->'sizes') = 'object'`
  );
  return Array.from(result.rows, (r) => r.value).filter(
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

export interface EpsonScannerFilterOptions {
  colorModes: string[];
  dpis: string[];
}

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
    default:
      return { kind: "default" };
  }
}

// ---------------------------------------------------------------------------
// Distinct users who have attributed any (non-deleted) run for this
// instrument — used to populate the "Ran By" column filter dropdown.
// ---------------------------------------------------------------------------

export interface RanByFilterOption {
  displayName: string;
  userId: string;
}

export async function getRanByFilterOptions(
  instrumentId?: string
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
        // Fleet-wide (dashboard) when no instrument is given; otherwise scope
        // to the one instrument's attributors.
        instrumentId
          ? eq(instrumentRuns.instrumentId, instrumentId)
          : undefined,
        isNull(instrumentRuns.deletedAt)
      )
    )
    .orderBy(users.name);

  return rows.map((r) => ({
    userId: r.userId,
    displayName: r.name ?? r.email ?? "Unknown",
  }));
}
