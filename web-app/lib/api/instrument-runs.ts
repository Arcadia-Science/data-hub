import { db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  runReportData,
} from "@/lib/db/schema";
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
        eq(instrumentRuns.runId, runId)
      )
    )
    .limit(1);

  return row ?? null;
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
};

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

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Single-query aggregation: counts per-run file stats using FILTER (WHERE ...)
  // to avoid N+1 queries. All non-deleted files are counted.
  const fileCount = sql<number>`cast(count(${files.id}) filter (where ${files.deletedAt} is null) as int)`;

  const filesCompleted = sql<number>`cast(count(${files.id}) filter (where ${files.status} = 'completed' and ${files.deletedAt} is null) as int)`;

  const filesFailed = sql<number>`cast(count(${files.id}) filter (where ${files.status} = 'failed' and ${files.deletedAt} is null) as int)`;

  // "Pending upload" = files on the instrument PC that haven't reached S3 yet.
  // A non-zero count signals the run has files requiring manual upload action.
  const filesPendingUpload = sql<number>`cast(count(${files.id}) filter (where ${files.status} in ('detected', 'upload_requested') and ${files.deletedAt} is null) as int)`;

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
    })
    .from(instrumentRuns)
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .leftJoin(files, eq(files.instrumentRunId, instrumentRuns.id))
    .where(where)
    .groupBy(instrumentRuns.id, instruments.displayName)
    .orderBy(orderFn(sortCol))
    .limit(perPage)
    .offset(offset);

  return {
    data: rows,
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

export type RunReportEntry = {
  id: number;
  dataType: string;
  fileId: number | null;
  data: unknown;
};

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
// Per-run report data — all report entries for a run, ordered by id.
// ---------------------------------------------------------------------------

export async function getRunReportData(
  runInternalId: string
): Promise<RunReportEntry[]> {
  const rows = await db
    .select({
      id: runReportData.id,
      dataType: runReportData.dataType,
      fileId: runReportData.fileId,
      data: runReportData.data,
    })
    .from(runReportData)
    .where(eq(runReportData.instrumentRunId, runInternalId))
    .orderBy(runReportData.id);

  return rows;
}
