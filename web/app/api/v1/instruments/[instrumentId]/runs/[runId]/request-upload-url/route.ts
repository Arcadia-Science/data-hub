import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  INTERNAL_ERROR,
  NOT_FOUND,
  PAYLOAD_TOO_LARGE,
} from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { beginMultipartUpload } from "@/lib/api/multipart-upload";
import { readJsonBody, requestUploadUrlBody } from "@/lib/api/openapi";
import {
  type IncomingRunFile,
  resolveRunFiles,
} from "@/lib/api/run-file-identity";
import { touchRuns } from "@/lib/api/touch-runs";
import { WATCHER_FEATURES, watcherClientFrom } from "@/lib/api/watcher-compat";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { multipartThresholdBytes, SINGLE_PUT_MAX_BYTES } from "@/lib/multipart";
import { getPresignedUploadUrl, getS3RawDataBucket } from "@/lib/s3";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

const UPLOAD_URL_EXPIRY_SECONDS = 60 * 60; // 1 hour

const UPLOADED_OR_LATER_STATUSES = new Set([
  "uploaded",
  "processing",
  "completed",
  "failed",
]);

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs/:runId/request-upload-url
//
// Returns a presigned S3 PUT URL so the watcher can upload a file without
// needing AWS credentials. Creates a file record if one doesn't already exist.
// Short-circuits with `already_uploaded: true` when the file has already
// reached S3.
//
// PAT-only: session `*` would let any member mint a presigned PUT for the
// canonical raw-data key. The dashboard queues uploads via `request-upload`.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorizeToken(request, "runs:upload");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  if (run.deletedAt) {
    return apiError(409, CONFLICT, "Cannot upload files to a soft-deleted run");
  }

  const body = await readJsonBody(request, requestUploadUrlBody);
  if (body instanceof Response) {
    return body;
  }

  const filename = body.filename;
  const contentType = body.content_type;
  const sizeBytes = body.size_bytes;
  const watcher = watcherClientFrom(request);
  if (sizeBytes != null && (!Number.isInteger(sizeBytes) || sizeBytes < 0)) {
    return apiError(
      400,
      "VALIDATION_ERROR",
      "size_bytes must be a whole number"
    );
  }
  if (
    !watcher.supports("multipartUpload") &&
    sizeBytes != null &&
    sizeBytes > SINGLE_PUT_MAX_BYTES
  ) {
    return apiError(
      413,
      PAYLOAD_TOO_LARGE,
      `Files over 5 GB need watcher ${WATCHER_FEATURES.multipartUpload} or newer.`
    );
  }
  const fileCreatedAt = body.file_created_at
    ? new Date(body.file_created_at)
    : null;
  const relativePath = watcher.supports("renameDuplicateFilenames")
    ? body.relative_path
    : undefined;

  // Older watchers match the row stored under the bare name. A folder
  // path can point at a renamed row when another folder took that name.
  const existingFile = relativePath
    ? await findOrCreateByPath(
        run.id,
        {
          relativePath,
          filename,
          sizeBytes: sizeBytes ?? null,
          fileCreatedAt,
        },
        contentType ?? null
      )
    : await findByFilename(run.id, filename);

  if (relativePath && !existingFile) {
    return apiError(
      409,
      CONFLICT,
      `Cannot store a file for '${relativePath}'. A dismissed file may already use that path.`
    );
  }

  if (existingFile && UPLOADED_OR_LATER_STATUSES.has(existingFile.status)) {
    return Response.json({
      already_uploaded: true,
      file_id: existingFile.id,
      s3_bucket: existingFile.s3Bucket,
      s3_key: existingFile.s3Key,
    });
  }

  let s3Bucket: string;
  try {
    s3Bucket = getS3RawDataBucket();
  } catch {
    return apiError(500, INTERNAL_ERROR, "S3 bucket configuration is missing");
  }

  const storedName = existingFile?.filename ?? filename;
  const s3Key = `${instrumentId}/${runId}/${storedName}`;

  let fileId: number;

  if (existingFile) {
    // File exists in detected / upload_requested — reuse the record.
    fileId = existingFile.id;
    // Backfill file_created_at if the watcher started reporting it after
    // the row was first inserted (e.g. a queue-mode upload following an
    // earlier detected_files report that predated this column).
    if (fileCreatedAt && !existingFile.fileCreatedAt) {
      await db
        .update(files)
        .set({ fileCreatedAt })
        .where(eq(files.id, existingFile.id));
    }
  } else {
    const now = new Date();
    const [inserted] = await db
      .insert(files)
      .values({
        instrumentRunId: run.id,
        relativePath: filename,
        filename,
        contentType: contentType ?? null,
        sizeBytes: sizeBytes ?? null,
        status: "detected",
        detectedAt: now,
        fileCreatedAt,
      })
      .returning({ id: files.id });

    fileId = inserted.id;
    await touchRuns([run.id]);
  }

  if (
    watcher.supports("multipartUpload") &&
    sizeBytes != null &&
    sizeBytes >= multipartThresholdBytes()
  ) {
    const started = await beginMultipartUpload({
      fileId,
      existingUploadId: existingFile?.multipartUploadId ?? null,
      bucket: s3Bucket,
      key: s3Key,
      contentType,
      sizeBytes,
    });
    if (started instanceof Response) {
      return started;
    }
    return Response.json({
      upload_type: "multipart",
      upload_id: started.uploadId,
      part_size: started.partSize,
      part_count: started.partCount,
      s3_bucket: s3Bucket,
      s3_key: s3Key,
      file_id: fileId,
      expires_in: started.expiresIn,
      already_uploaded: false,
    });
  }

  const uploadUrl = await getPresignedUploadUrl(
    s3Bucket,
    s3Key,
    contentType,
    UPLOAD_URL_EXPIRY_SECONDS
  );

  return Response.json({
    upload_url: uploadUrl,
    s3_bucket: s3Bucket,
    s3_key: s3Key,
    file_id: fileId,
    expires_in: UPLOAD_URL_EXPIRY_SECONDS,
    already_uploaded: false,
  });
}

async function findByFilename(instrumentRunId: string, filename: string) {
  const [existingFile] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, instrumentRunId),
        eq(files.filename, filename),
        isNull(files.deletedAt)
      )
    )
    .limit(1);
  return existingFile ?? null;
}

async function loadActiveFile(id: number) {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
    .limit(1);
  return row ?? null;
}

// A conflict means another request stored this path first. Deciding
// again reuses that row, or takes the folder-hash name.
async function findOrCreateByPath(
  instrumentRunId: string,
  incoming: IncomingRunFile,
  contentType: string | null
) {
  const insertRow = async (storedName: string) => {
    const [inserted] = await db
      .insert(files)
      .values({
        instrumentRunId,
        relativePath: incoming.relativePath,
        filename: storedName,
        contentType,
        sizeBytes: incoming.sizeBytes,
        status: "detected",
        detectedAt: new Date(),
        fileCreatedAt: incoming.fileCreatedAt,
      })
      .onConflictDoNothing()
      .returning({ id: files.id });
    if (!inserted) {
      return null;
    }
    await touchRuns([instrumentRunId]);
    return loadActiveFile(inserted.id);
  };

  let [decision] = await resolveRunFiles(db, instrumentRunId, [incoming]);
  if (decision?.action === "existing" && decision.fileId != null) {
    return await loadActiveFile(decision.fileId);
  }

  const created = await insertRow(
    decision?.action === "insert" ? decision.filename : incoming.filename
  );
  if (created) {
    return created;
  }

  [decision] = await resolveRunFiles(db, instrumentRunId, [incoming]);
  if (decision?.action === "existing" && decision.fileId != null) {
    return await loadActiveFile(decision.fileId);
  }
  if (decision?.action === "insert") {
    return await insertRow(decision.filename);
  }
  return null;
}
