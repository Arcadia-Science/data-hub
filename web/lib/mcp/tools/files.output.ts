import { z } from "zod";
import {
  fileCategorySchema,
  fileStatusSchema,
  isoDateTime,
} from "@/lib/api/openapi/schemas/common";

/** Full `files` row as returned by `get_file` after JSON round-trip. */
export const getFileOutputSchema = z.object({
  id: z.number().int(),
  instrumentRunId: z.string(),
  filename: z.string(),
  relativePath: z.string().nullable(),
  s3Bucket: z.string().nullable(),
  s3Key: z.string().nullable(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  category: fileCategorySchema,
  status: fileStatusSchema,
  metadata: z.record(z.string(), z.unknown()),
  errorMessage: z.string().nullable(),
  detectedAt: isoDateTime.nullable(),
  uploadRequestedAt: isoDateTime.nullable(),
  uploadedAt: isoDateTime.nullable(),
  processedAt: isoDateTime.nullable(),
  processingStartedAt: isoDateTime.nullable(),
  fileCreatedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  deletedAt: isoDateTime.nullable(),
  stalled: z.boolean(),
});

export const getFileDownloadUrlOutputSchema = z.object({
  fileId: z.number().int(),
  filename: z.string(),
  downloadUrl: z.string(),
  expiresInSeconds: z.number().int(),
});

export const getRunArchiveOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    instrumentId: z.string(),
    runId: z.string(),
    downloadUrl: z.string(),
    filename: z.string(),
    sizeBytes: z.number().nullable(),
    expiresInSeconds: z.number().int(),
    contentType: z.literal("application/zip"),
  }),
  z.object({
    status: z.literal("building"),
    instrumentId: z.string(),
    runId: z.string(),
    jobId: z.string(),
    retryAfterSeconds: z.number().int(),
    hint: z.string(),
  }),
]);

export const reprocessFileOutputSchema = z.object({
  status: z.literal("processing"),
  fileId: z.number().int(),
});

export const dismissFileOutputSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  deletedAt: isoDateTime,
  alreadyApplied: z.boolean(),
});
