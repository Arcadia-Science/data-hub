import {
  and,
  asc,
  eq,
  ilike,
  isNull,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import { type AnyPgColumn, alias } from "drizzle-orm/pg-core";
import { escapeLikePattern } from "@/lib/api/like-pattern";
import { db } from "@/lib/db";
import { NATURAL_FILENAME_COLLATION } from "@/lib/db/collations";
import { files } from "@/lib/db/schema";
import {
  REPORT_ITEMS_MAX_LIMIT,
  type ReportItem,
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

// The columns a kind predicate reads, so the same check runs on `files` and
// on an aliased copy of it in a subquery.
interface FileColumns {
  contentType: AnyPgColumn;
  filename: AnyPgColumn;
}

const isImage = (file: FileColumns) => sql`(
  ${file.contentType} in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
  or lower(${file.filename}) like '%.png'
  or lower(${file.filename}) like '%.jpg'
  or lower(${file.filename}) like '%.jpeg'
  or lower(${file.filename}) like '%.gif'
  or lower(${file.filename}) like '%.webp'
)`;

const isVideo = (file: FileColumns) => sql`(
  ${file.contentType} like 'video/%'
  or lower(${file.filename}) like '%.mp4'
)`;

// The filename without its last extension, matching `fileStem` in
// `lib/runs/run-file-types.ts`: a leading dot is part of the name.
const stem = (filename: AnyPgColumn) =>
  sql`regexp_replace(${filename}, '(.)\\.[^.]*$', '\\1')`;

interface SiblingColumns extends FileColumns {
  deletedAt: AnyPgColumn;
  instrumentRunId: AnyPgColumn;
  s3Bucket: AnyPgColumn;
  s3Key: AnyPgColumn;
}

// Another stored, renderable file in the same run with the same stem.
function sameStemSibling(sibling: SiblingColumns) {
  return and(
    eq(sibling.instrumentRunId, files.instrumentRunId),
    isNull(sibling.deletedAt),
    sql`${sibling.s3Bucket} is not null and ${sibling.s3Key} is not null`,
    sql`${stem(sibling.filename)} = ${stem(files.filename)}`
  );
}

const videoSibling = alias(files, "video_sibling");
const poster = alias(files, "poster");

// A timelapse has `{stem}.mp4` and its poster `{stem}.jpg`. `media` lists
// the video and drops the poster, so each source file is one item.
const mediaPredicate = sql`(
  ${isVideo(files)}
  or (
    ${isImage(files)}
    and ${notExists(
      db
        .select({ id: videoSibling.id })
        .from(videoSibling)
        .where(and(sameStemSibling(videoSibling), isVideo(videoSibling)))
    )}
  )
)`;

// The poster for a `media` video: the image with the same stem, or null.
// `node-postgres` returns a bare bigint as a string, so map it back to the
// number the `id` column gives elsewhere. Drizzle skips the mapping for null.
const posterIdColumn = sql<number | null>`(${db
  .select({ id: poster.id })
  .from(poster)
  .where(and(sameStemSibling(poster), isVideo(files), isImage(poster)))
  .orderBy(asc(poster.id))
  .limit(1)})`.mapWith(Number);

const KIND_PREDICATES: Record<ReportItemKind, SQL> = {
  image: isImage(files),
  media: mediaPredicate,
  pdf: sql`(
    ${files.contentType} = 'application/pdf'
    or lower(${files.filename}) like '%.pdf'
  )`,
  spectrum: sql`(
    ${files.contentType} = 'text/csv'
    or lower(${files.filename}) like '%.csv'
  )`,
  video: isVideo(files),
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

  const data: ReportItem[] = await db
    .select({
      id: files.id,
      filename: files.filename,
      ...(kind === "media" ? { poster_id: posterIdColumn } : {}),
    })
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
