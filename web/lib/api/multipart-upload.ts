import { and, eq, inArray, isNull } from "drizzle-orm";
import { apiError, CONFLICT, NOT_FOUND } from "@/lib/api/errors";
import { touchRuns } from "@/lib/api/touch-runs";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";
import {
  PART_URL_BATCH_LIMIT,
  PART_URL_EXPIRY_SECONDS,
  planMultipartUpload,
} from "@/lib/multipart";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  getPresignedUploadPartUrl,
  getS3RawDataBucket,
  headObjectChecksum,
  MultipartUploadError,
} from "@/lib/s3";

const PRE_UPLOAD = new Set(["detected", "upload_requested"]);
// These are about the bytes the watcher sent. It can retry or start over.
// Anything else (a missing permission, a 503) is reported as 502 so it is
// not mistaken for a bad token.
const CALLER_FIXABLE_S3_ERRORS = new Set([
  "BadDigest",
  "InvalidPart",
  "InvalidPartOrder",
  "EntityTooSmall",
  "NoSuchUpload",
]);
const UPLOADED_OR_LATER = new Set([
  "uploaded",
  "processing",
  "completed",
  "failed",
]);

export interface MultipartFileContext {
  bucket: string;
  fileId: number;
  filename: string;
  instrumentId: string;
  instrumentRunId: string;
  key: string;
  multipartUploadId: string | null;
  runId: string;
  sizeBytes: number | null;
  status: string;
}

export async function loadMultipartFile(
  fileId: number
): Promise<MultipartFileContext | Response> {
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt)))
    .limit(1);
  if (!file) {
    return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  const [parentRun] = await db
    .select({
      deletedAt: instrumentRuns.deletedAt,
      instrumentId: instrumentRuns.instrumentId,
      runId: instrumentRuns.runId,
    })
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, file.instrumentRunId))
    .limit(1);
  if (!parentRun || parentRun.deletedAt) {
    return apiError(409, CONFLICT, "Cannot upload files to a soft-deleted run");
  }

  let bucket: string;
  try {
    bucket = getS3RawDataBucket();
  } catch {
    return apiError(
      500,
      "INTERNAL_ERROR",
      "S3 bucket configuration is missing"
    );
  }

  return {
    fileId: file.id,
    status: file.status,
    filename: file.filename,
    sizeBytes: file.sizeBytes,
    multipartUploadId: file.multipartUploadId,
    instrumentRunId: file.instrumentRunId,
    instrumentId: parentRun.instrumentId,
    runId: parentRun.runId,
    bucket,
    key: `${parentRun.instrumentId}/${parentRun.runId}/${file.filename}`,
  };
}

export function multipartErrorResponse(err: unknown): Response {
  if (err instanceof MultipartUploadError) {
    const status = CALLER_FIXABLE_S3_ERRORS.has(err.code) ? 400 : 502;
    return apiError(status, err.code, err.message, { s3_code: err.code });
  }
  throw err;
}

export async function beginMultipartUpload(input: {
  fileId: number;
  existingUploadId: string | null;
  bucket: string;
  key: string;
  contentType: string | undefined;
  sizeBytes: number;
}): Promise<
  | {
      uploadId: string;
      partSize: number;
      partCount: number;
      expiresIn: number;
    }
  | Response
> {
  const plan = planMultipartUpload(input.sizeBytes);
  if (input.existingUploadId) {
    try {
      await abortMultipartUpload(
        input.bucket,
        input.key,
        input.existingUploadId
      );
    } catch (err) {
      // Complete only sends the id stored on the row, so a replaced id
      // cannot become the object. The bucket deletes leftovers after 7 days.
      console.error(
        "Could not cancel the previous multipart upload; starting a new one",
        err
      );
    }
  }

  let uploadId: string;
  try {
    uploadId = await createMultipartUpload(
      input.bucket,
      input.key,
      input.contentType
    );
  } catch (err) {
    return multipartErrorResponse(err);
  }

  try {
    await db
      .update(files)
      .set({
        multipartUploadId: uploadId,
        sizeBytes: input.sizeBytes,
        ...(input.contentType ? { contentType: input.contentType } : {}),
      })
      .where(eq(files.id, input.fileId));
  } catch (err) {
    await abortMultipartUpload(input.bucket, input.key, uploadId).catch(
      () => undefined
    );
    throw err;
  }

  return {
    uploadId,
    partSize: plan.partSize,
    partCount: plan.partCount,
    expiresIn: PART_URL_EXPIRY_SECONDS,
  };
}

export async function signPartUrls(
  file: MultipartFileContext,
  uploadId: string,
  partNumbers: number[]
): Promise<{ partNumber: number; uploadUrl: string }[] | Response> {
  if (file.multipartUploadId !== uploadId || !PRE_UPLOAD.has(file.status)) {
    return apiError(409, CONFLICT, "This upload is no longer in progress");
  }
  if (partNumbers.length < 1 || partNumbers.length > PART_URL_BATCH_LIMIT) {
    return apiError(
      400,
      "VALIDATION_ERROR",
      `Request between 1 and ${PART_URL_BATCH_LIMIT} part numbers`
    );
  }
  if (file.sizeBytes == null) {
    return apiError(409, CONFLICT, "This file has no recorded size");
  }
  const { partCount } = planMultipartUpload(file.sizeBytes);
  const seen = new Set<number>();
  for (const partNumber of partNumbers) {
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > partCount ||
      seen.has(partNumber)
    ) {
      return apiError(
        400,
        "VALIDATION_ERROR",
        `Part number ${partNumber} is not part of this upload`
      );
    }
    seen.add(partNumber);
  }

  return await Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      uploadUrl: await getPresignedUploadPartUrl(
        file.bucket,
        file.key,
        uploadId,
        partNumber
      ),
    }))
  );
}

async function markUploaded(file: MultipartFileContext): Promise<boolean> {
  // Only move a row that is still waiting. The Lambda can adopt the file
  // as soon as S3 finishes, and overwriting `processing` would hide that.
  const updated = await db
    .update(files)
    .set({
      status: "uploaded",
      uploadedAt: new Date(),
      s3Bucket: file.bucket,
      s3Key: file.key,
      multipartUploadId: null,
      sizeBytes: file.sizeBytes,
    })
    .where(
      and(
        eq(files.id, file.fileId),
        inArray(files.status, ["detected", "upload_requested"])
      )
    )
    .returning({ id: files.id });
  if (updated.length === 0) {
    await db
      .update(files)
      .set({ multipartUploadId: null })
      .where(eq(files.id, file.fileId));
  }
  await touchRuns([file.instrumentRunId]);
  return updated.length > 0;
}

export async function finishMultipartUpload(
  file: MultipartFileContext,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
  checksumCrc64nvme: string
): Promise<Response> {
  if (UPLOADED_OR_LATER.has(file.status)) {
    // The processor can adopt the row as soon as S3 finishes. Clear the
    // upload id so a later restart does not try to cancel a finished upload.
    await db
      .update(files)
      .set({ multipartUploadId: null })
      .where(eq(files.id, file.fileId));
    return Response.json({
      file_id: file.fileId,
      status: file.status,
      already_uploaded: true,
    });
  }
  if (file.multipartUploadId !== uploadId || !PRE_UPLOAD.has(file.status)) {
    return apiError(409, CONFLICT, "This upload is no longer in progress");
  }
  if (file.sizeBytes == null) {
    return apiError(409, CONFLICT, "This file has no recorded size");
  }

  const { partCount } = planMultipartUpload(file.sizeBytes);
  const numbers = parts.map((part) => part.partNumber).sort((a, b) => a - b);
  const expected = Array.from({ length: partCount }, (_, index) => index + 1);
  if (
    numbers.length !== expected.length ||
    numbers.some((number, index) => number !== expected[index])
  ) {
    return apiError(
      400,
      "VALIDATION_ERROR",
      `Complete the upload with parts 1 through ${partCount} in order`
    );
  }
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);

  const stored = {
    bucket: file.bucket,
    key: file.key,
    uploadId,
    parts: ordered,
    checksumCrc64nvme,
    sizeBytes: file.sizeBytes,
  };

  try {
    await completeMultipartUpload(stored);
  } catch (err) {
    if (err instanceof MultipartUploadError && err.code === "NoSuchUpload") {
      const head = await headObjectChecksum(file.bucket, file.key);
      const recovered =
        head != null &&
        head.sizeBytes === file.sizeBytes &&
        head.checksumCrc64nvme === checksumCrc64nvme;
      if (!recovered) {
        return multipartErrorResponse(err);
      }
    } else {
      return multipartErrorResponse(err);
    }
  }

  const marked = await markUploaded(file);
  return Response.json({
    file_id: file.fileId,
    status: "uploaded",
    already_uploaded: !marked,
  });
}

export async function cancelMultipartUpload(
  file: MultipartFileContext,
  uploadId: string
): Promise<Response> {
  if (file.multipartUploadId !== uploadId) {
    return apiError(409, CONFLICT, "This upload is no longer in progress");
  }
  try {
    await abortMultipartUpload(file.bucket, file.key, uploadId);
  } catch (err) {
    return multipartErrorResponse(err);
  }
  await db
    .update(files)
    .set({ multipartUploadId: null })
    .where(eq(files.id, file.fileId));
  return Response.json({ file_id: file.fileId, aborted: true });
}
