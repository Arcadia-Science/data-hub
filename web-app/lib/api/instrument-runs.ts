import { db } from "@/lib/db";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
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

const ALLOWED_SORT_FIELDS: Record<
  string,
  (typeof instrumentRuns)["createdAt" | "updatedAt"]
> = {
  created_at: instrumentRuns.createdAt,
  updated_at: instrumentRuns.updatedAt,
};

export async function buildRunListQuery(filters: RunListFilters) {
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
  if (filters.dateTo) {
    const end = new Date(filters.dateTo);
    end.setDate(end.getDate() + 1);
    conditions.push(lte(instrumentRuns.createdAt, end));
  }

  if (filters.search) {
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

  const totalPages = Math.ceil(total / filters.perPage);
  const offset = (filters.page - 1) * filters.perPage;

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
    .limit(filters.perPage)
    .offset(offset);

  return {
    data: rows,
    pagination: {
      page: filters.page,
      per_page: filters.perPage,
      total,
      total_pages: totalPages,
    },
  };
}
