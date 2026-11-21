import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { UPLOAD_ARRIVED_RESET } from "@/lib/api/upload-state";
import { type DbExecutor, db } from "@/lib/db";
import { hasPgErrorCode, UNIQUE_VIOLATION } from "@/lib/db/pg-error";
import { files, instrumentRuns } from "@/lib/db/schema";
import { PRE_UPLOAD_FILE_STATUSES } from "@/lib/runs/file-buckets";

export type FileRow = typeof files.$inferSelect;

export type AdoptedFileValues = Pick<
  typeof files.$inferInsert,
  "s3Bucket" | "s3Key" | "contentType" | "sizeBytes" | "category" | "uploadedAt"
>;

// What `adoptPreUploadFile` did:
// - `adopted`: the row is now `uploaded` at the given location.
// - `moved_on`: the row left pre-upload after the caller read it; `row` is
//   how it is now, untouched.
// - `dismissed`: the row was dismissed after the caller read it. It no longer
//   blocks a new row with the same name, so the caller can insert one.
export type AdoptResult =
  | { kind: "adopted"; row: FileRow }
  | { kind: "moved_on"; row: FileRow }
  | { kind: "dismissed" };

// Moves a pre-upload row to `uploaded` at the given S3 location: the Lambda
// found the file's bytes before the watcher reported them.
//
// The pre-upload check is part of the write. Between the caller's read and
// this update, the watcher's PATCH can mark the row uploaded and processing
// can start. An update keyed on the ID alone would then move the row back to
// `uploaded` and rewrite a location that is meant to be set only once.
export async function adoptPreUploadFile(
  fileId: number,
  values: AdoptedFileValues
): Promise<AdoptResult> {
  const [updated] = await db
    .update(files)
    .set({ ...values, ...UPLOAD_ARRIVED_RESET, status: "uploaded" })
    .where(
      and(
        eq(files.id, fileId),
        inArray(files.status, PRE_UPLOAD_FILE_STATUSES),
        isNull(files.deletedAt)
      )
    )
    .returning();
  if (updated) {
    return { kind: "adopted", row: updated };
  }
  const [current] = await db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  // File rows are never hard-deleted, so a missing row is treated like a
  // dismissed one.
  if (!current || current.deletedAt) {
    return { kind: "dismissed" };
  }
  return { kind: "moved_on", row: current };
}

// How a file is deleted: when, and by whom.
export interface FileDeletion {
  deletedAt: Date;
  deletedBy: string | null;
  deletedByToken: string | null;
}

// How a processed file made from `sourceFileId` is to be saved: deleted the
// same way as its source when the source is deleted, and null otherwise. An
// output of a raw file that was deleted while it processed is saved deleted,
// so the two stay together.
//
// Call it first in the transaction that writes the output. The share lock on
// the source makes `deleteFiles`, which locks the source for update, wait for
// that transaction, or makes this wait for the delete and then read it. Either
// way the output can't be saved active beside a deleted source, and the delete
// finds an output committed before it as a linked file. Locking the raw file
// before its output is the order `deleteFiles` uses, so the two can't wait for
// each other. `restoreFiles` locks the other way round only when it brings a
// deleted output back with its deleted source. If that ever meets a revive of
// the same output, Postgres ends one with a deadlock error, a 500 that the
// Lambda retries.
export async function lockSourceDeletion(
  executor: DbExecutor,
  sourceFileId: number | null
): Promise<FileDeletion | null> {
  if (sourceFileId === null) {
    return null;
  }
  const [source] = await executor
    .select({
      deletedAt: files.deletedAt,
      deletedBy: files.deletedBy,
      deletedByToken: files.deletedByToken,
    })
    .from(files)
    .where(eq(files.id, sourceFileId))
    .for("share");
  return source?.deletedAt
    ? {
        deletedAt: source.deletedAt,
        deletedBy: source.deletedBy,
        deletedByToken: source.deletedByToken,
      }
    : null;
}

// Links an existing processed file to the raw file it was made from, when it
// has no source yet: an output written before `source_file_id` existed, which
// the backfill could not match, gets linked on its next reprocess. A source
// that is already set is never replaced. Returns the row as it is now.
export async function fillMissingSource(
  file: FileRow,
  sourceFileId: number | null
): Promise<FileRow> {
  if (
    sourceFileId === null ||
    file.category !== "processed" ||
    file.sourceFileId !== null
  ) {
    return file;
  }
  const [filled] = await db
    .update(files)
    .set({ sourceFileId })
    .where(
      and(
        eq(files.id, file.id),
        eq(files.category, "processed"),
        isNull(files.sourceFileId)
      )
    )
    .returning();
  return filled ?? file;
}

export interface RevivedFileValues {
  contentType: string | null;
  sizeBytes: number | null;
  // The raw file the output was made from. The output is saved deleted when
  // that file is deleted (`lockSourceDeletion`).
  sourceFileId: number | null;
}

// What `reviveProcessedFile` did:
// - `revived`: the row is a fresh `uploaded` output again.
// - `unchanged`: the row was no longer deleted when the update ran, because a
//   restore or another revive got there first; `row` is how it is now.
// - `conflict`: another active file now holds the row's filename or path, so it
//   can't be active again.
export type ReviveResult =
  | { kind: "revived"; row: FileRow }
  | { kind: "unchanged"; row: FileRow | null }
  | { kind: "conflict" };

// A processor wrote a processed file whose S3 key belongs to a deleted row:
// reprocessing made the same output again, over the old object. The row
// becomes the new output, so the file isn't left hidden and the processor
// isn't left holding a deleted row.
//
// Only a deleted processed row is revived. The write checks that, so a row
// that was restored in the meantime is left as the restore made it. What the
// earlier run of the processor reported is reset, as it is on a new row. The
// row keeps its ID and its creation time. It stays deleted, the way its source
// is, when the source is deleted.
export async function reviveProcessedFile(
  fileId: number,
  values: RevivedFileValues
): Promise<ReviveResult> {
  try {
    const revived = await db.transaction(async (tx) => {
      const deletion = await lockSourceDeletion(tx, values.sourceFileId);
      const [row] = await tx
        .update(files)
        .set({
          ...UPLOAD_ARRIVED_RESET,
          status: "uploaded",
          uploadedAt: new Date(),
          contentType: values.contentType,
          sizeBytes: values.sizeBytes,
          sourceFileId: values.sourceFileId,
          metadata: {},
          processedAt: null,
          processingStartedAt: null,
          queuedAt: null,
          dispatchId: null,
          stallRequeues: 0,
          deletedAt: deletion?.deletedAt ?? null,
          deletedBy: deletion?.deletedBy ?? null,
          deletedByToken: deletion?.deletedByToken ?? null,
        })
        .where(
          and(
            eq(files.id, fileId),
            eq(files.category, "processed"),
            isNotNull(files.deletedAt)
          )
        )
        .returning();
      return row;
    });
    if (revived) {
      return { kind: "revived", row: revived };
    }
  } catch (error) {
    // A unique violation ends the transaction, so it is caught out here.
    if (hasPgErrorCode(error, UNIQUE_VIOLATION)) {
      return { kind: "conflict" };
    }
    throw error;
  }
  const [current] = await db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  return { kind: "unchanged", row: current ?? null };
}

// Fetches a file by numeric ID, deleted or not. A deleted file stays readable
// by its ID, as it stays downloadable.
export async function getFileById(fileId: number): Promise<FileRow | null> {
  const [file] = await db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  return file ?? null;
}

// Fetches an active (not soft-deleted) file by numeric ID.
export async function getActiveFileById(
  fileId: number
): Promise<FileRow | null> {
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt)))
    .limit(1);
  return file ?? null;
}

export async function getActiveFilesByIds(ids: number[]): Promise<
  Array<{
    contentType: string | null;
    filename: string;
    id: number;
    s3Bucket: string | null;
    s3Key: string | null;
  }>
> {
  if (ids.length === 0) {
    return [];
  }
  return await db
    .select({
      id: files.id,
      contentType: files.contentType,
      filename: files.filename,
      s3Bucket: files.s3Bucket,
      s3Key: files.s3Key,
    })
    .from(files)
    .where(and(inArray(files.id, ids), isNull(files.deletedAt)));
}

// Filename suffix match for JSON artifacts (e.g. `_aunty_plate.json`).
export async function findActiveFileBySuffix(
  runInternalId: string,
  suffix: string
): Promise<FileRow | null> {
  if (suffix.length === 0) {
    return null;
  }
  const [file] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, runInternalId),
        isNull(files.deletedAt),
        sql`right(${files.filename}, ${suffix.length}) = ${suffix}`
      )
    )
    .limit(1);
  return file ?? null;
}

export type FileDownloadLookup =
  | {
      category: string;
      contentType: string | null;
      filename: string;
      ok: true;
      // Internal ID of the file's run.
      runUuid: string;
      s3Bucket: string;
      s3Key: string;
    }
  | { ok: false; reason: "not_found" | "not_uploaded" };

// Resolves a file ID into the S3 coordinates needed to produce a pre-signed
// download URL. Returns `not_found` when the file doesn't exist or its parent
// run is soft-deleted, and `not_uploaded` when the file hasn't reached S3 yet.
//
// A soft-deleted file is found. Its object stays in storage, and someone who
// deleted a file by mistake can still open or download it by its ID. The lists,
// "Download all" and "Download filtered" leave deleted files out on their own.
export async function lookupFileForDownload(
  fileId: number
): Promise<FileDownloadLookup> {
  const [file] = await db
    .select({
      category: files.category,
      contentType: files.contentType,
      filename: files.filename,
      s3Bucket: files.s3Bucket,
      s3Key: files.s3Key,
      instrumentRunId: files.instrumentRunId,
    })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);

  if (!file) {
    return { ok: false, reason: "not_found" };
  }

  const [parentRun] = await db
    .select({ deletedAt: instrumentRuns.deletedAt })
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, file.instrumentRunId))
    .limit(1);

  if (parentRun?.deletedAt) {
    return { ok: false, reason: "not_found" };
  }

  if (!(file.s3Bucket && file.s3Key)) {
    return { ok: false, reason: "not_uploaded" };
  }

  return {
    ok: true,
    category: file.category,
    contentType: file.contentType,
    filename: file.filename,
    runUuid: file.instrumentRunId,
    s3Bucket: file.s3Bucket,
    s3Key: file.s3Key,
  };
}

export interface DownloadableRunFilesSummary {
  count: number;
  // Sum of `size_bytes` across all matching files, or null when at least one
  // file is missing its size. The UI uses this to decide whether to expect
  // a sync 302 or an async 202 from the archive route.
  totalSizeBytes: number | null;
}

export async function summarizeDownloadableRunFiles(
  runInternalId: string
): Promise<DownloadableRunFilesSummary> {
  const [row] = await db
    .select({
      count: sql<number>`cast(count(*) as int)`,
      totalSize: sql<string | null>`sum(${files.sizeBytes})`,
      anyNull: sql<boolean>`bool_or(${files.sizeBytes} is null)`,
    })
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, runInternalId),
        isNull(files.deletedAt),
        isNotNull(files.s3Bucket),
        isNotNull(files.s3Key)
      )
    );
  const count = row?.count ?? 0;
  if (count === 0) {
    return { count: 0, totalSizeBytes: 0 };
  }
  const totalSizeBytes =
    row?.anyNull || row?.totalSize === null
      ? null
      : Number.parseInt(row.totalSize as string, 10);
  return { count, totalSizeBytes };
}
