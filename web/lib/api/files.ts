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

export type DownloadableRunFilesSummary = {
  count: number;
  // Sum of `size_bytes` across all matching files, or null when at least one
  // file is missing its size. The UI uses this to decide whether to expect
  // a sync 302 or an async 202 from the archive route.
  totalSizeBytes: number | null;
};

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
  if (count === 0) return { count: 0, totalSizeBytes: 0 };
  const totalSizeBytes =
    row?.anyNull || row?.totalSize === null
      ? null
      : Number.parseInt(row.totalSize as string, 10);
  return { count, totalSizeBytes };
}
