import { and, eq, ilike, isNull, type SQL, sql } from "drizzle-orm";
import { escapeLikePattern } from "@/lib/api/like-pattern";
import { db } from "@/lib/db";
import { NATURAL_FILENAME_COLLATION } from "@/lib/db/collations";
import { files } from "@/lib/db/schema";
import {
  REPORT_ITEMS_MAX_LIMIT,
  type ReportItemKind,
  type ReportItemsPage,
} from "@/lib/runs/report-items";

export interface ReportItemsQuery {
  // File id to centre the window on. Overrides `offset` when it resolves.
  anchorId?: number;
  kind: ReportItemKind;
  limit: number;
  offset: number;
  search?: string;
}

const naturalFilename = sql`${files.filename} collate ${sql.identifier(NATURAL_FILENAME_COLLATION)}`;

const KIND_PREDICATES: Record<ReportItemKind, SQL> = {
  image: sql`(
    ${files.contentType} in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
    or lower(${files.filename}) like '%.png'
    or lower(${files.filename}) like '%.jpg'
    or lower(${files.filename}) like '%.jpeg'
    or lower(${files.filename}) like '%.gif'
    or lower(${files.filename}) like '%.webp'
  )`,
  pdf: sql`(
    ${files.contentType} = 'application/pdf'
    or lower(${files.filename}) like '%.pdf'
  )`,
  spectrum: sql`(
    ${files.contentType} = 'text/csv'
    or lower(${files.filename}) like '%.csv'
  )`,
};

function reportItemsWhere(
  runInternalId: string,
  kind: ReportItemKind,
  search: string | undefined
) {
  const conditions: SQL[] = [
    eq(files.instrumentRunId, runInternalId),
    isNull(files.deletedAt),
    // Only files with bytes in S3 can render, so items still awaiting upload
    // are excluded rather than shown broken.
    sql`${files.s3Bucket} is not null and ${files.s3Key} is not null`,
    KIND_PREDICATES[kind],
  ];

  if (search) {
    conditions.push(ilike(files.filename, `%${escapeLikePattern(search)}%`));
  }

  return and(...conditions);
}

// Position of `anchorId` in the ordering, so the client can drop a search
// filter and keep seeking from the item it selected.
async function resolveAnchorIndex(
  where: SQL | undefined,
  anchorId: number
): Promise<number | null> {
  const [anchor] = await db
    .select({ filename: files.filename })
    .from(files)
    .where(and(where, eq(files.id, anchorId)))
    .limit(1);

  if (!anchor) {
    return null;
  }

  const [{ index }] = await db
    .select({ index: sql<number>`cast(count(*) as int)` })
    .from(files)
    .where(and(where, sql`${naturalFilename} < ${anchor.filename}`));

  return index;
}

// The numeric-aware collation rules out an index-ordered scan, so Postgres
// sorts per request — cheap at the thousands of files this targets.
export async function getReportItemsPage(
  runInternalId: string,
  { anchorId, kind, search, offset, limit }: ReportItemsQuery
): Promise<ReportItemsPage> {
  const safeLimit = Math.min(Math.max(limit, 1), REPORT_ITEMS_MAX_LIMIT);
  const where = reportItemsWhere(runInternalId, kind, search);

  const [{ total }] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(files)
    .where(where);

  const anchorIndex =
    anchorId === undefined ? null : await resolveAnchorIndex(where, anchorId);
  const safeOffset =
    anchorIndex === null
      ? Math.max(offset, 0)
      : Math.floor(anchorIndex / safeLimit) * safeLimit;

  const data = await db
    .select({ id: files.id, filename: files.filename })
    .from(files)
    .where(where)
    .orderBy(naturalFilename)
    .limit(safeLimit)
    .offset(safeOffset);

  return {
    data,
    pagination: {
      anchor_index: anchorIndex,
      limit: safeLimit,
      offset: safeOffset,
      total,
    },
  };
}
