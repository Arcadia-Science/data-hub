import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

export type FileRow = typeof files.$inferSelect;

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

export type FileDownloadLookup =
  | { ok: true; filename: string; s3Bucket: string; s3Key: string }
  | { ok: false; reason: "not_found" | "not_uploaded" };

// Resolves a file ID into the S3 coordinates needed to produce a pre-signed
// download URL. Returns `not_found` when the file or its parent run is
// soft-deleted, and `not_uploaded` when the file hasn't reached S3 yet.
export async function lookupFileForDownload(
  fileId: number
): Promise<FileDownloadLookup> {
  const [file] = await db
    .select({
      filename: files.filename,
      s3Bucket: files.s3Bucket,
      s3Key: files.s3Key,
      deletedAt: files.deletedAt,
      instrumentRunId: files.instrumentRunId,
    })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);

  if (!file || file.deletedAt) {
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

  if (!file.s3Bucket || !file.s3Key) {
    return { ok: false, reason: "not_uploaded" };
  }

  return {
    ok: true,
    filename: file.filename,
    s3Bucket: file.s3Bucket,
    s3Key: file.s3Key,
  };
}

// Counts files in a run that are eligible for archive download (uploaded to
// S3 and not soft-deleted). Matches the filter applied by the
// download-archive route so callers can issue a meaningful preflight check.
export async function countDownloadableRunFiles(
  runInternalId: string
): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, runInternalId),
        isNull(files.deletedAt),
        isNotNull(files.s3Bucket),
        isNotNull(files.s3Key)
      )
    );
  return count ?? 0;
}
