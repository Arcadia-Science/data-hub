import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";

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
      contentType: string | null;
      filename: string;
      ok: true;
      s3Bucket: string;
      s3Key: string;
    }
  | { ok: false; reason: "not_found" | "not_uploaded" };

// Resolves a file ID into the S3 coordinates needed to produce a pre-signed
// download URL. Returns `not_found` when the file or its parent run is
// soft-deleted, and `not_uploaded` when the file hasn't reached S3 yet.
export async function lookupFileForDownload(
  fileId: number
): Promise<FileDownloadLookup> {
  const [file] = await db
    .select({
      contentType: files.contentType,
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

  if (!(file.s3Bucket && file.s3Key)) {
    return { ok: false, reason: "not_uploaded" };
  }

  return {
    ok: true,
    contentType: file.contentType,
    filename: file.filename,
    s3Bucket: file.s3Bucket,
    s3Key: file.s3Key,
  };
}

export type DismissFileResult =
  | {
      ok: true;
      id: number;
      filename: string;
      deletedAt: Date;
      // True when the file was already soft-deleted, so the call made no change.
      // Lets `dismiss_file` / DELETE stay idempotent (success, not 409).
      alreadyApplied: boolean;
    }
  | {
      ok: false;
      status: number;
      code: "NOT_FOUND" | "CONFLICT";
      message: string;
    };

// Pre-upload dismiss only — once a file is on S3, deletion stays at the run boundary.
// Shared by REST DELETE `/files/:id` and MCP `dismiss_file`.
export async function dismissFile(fileId: number): Promise<DismissFileResult> {
  const [file] = await db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);

  if (!file) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: `File '${fileId}' not found`,
    };
  }

  if (file.deletedAt) {
    // Idempotent: already dismissed, so report success with the existing
    // deletion timestamp instead of a 409 conflict.
    return {
      ok: true,
      id: file.id,
      filename: file.filename,
      deletedAt: file.deletedAt,
      alreadyApplied: true,
    };
  }

  if (file.status !== "detected" && file.status !== "upload_requested") {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `Cannot dismiss a file in '${file.status}' status — only 'detected' or 'upload_requested' files can be dismissed`,
    };
  }

  const now = new Date();
  await db.update(files).set({ deletedAt: now }).where(eq(files.id, fileId));
  await db
    .update(instrumentRuns)
    .set({ updatedAt: now })
    .where(eq(instrumentRuns.id, file.instrumentRunId));

  return {
    ok: true,
    id: file.id,
    filename: file.filename,
    deletedAt: now,
    alreadyApplied: false,
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
