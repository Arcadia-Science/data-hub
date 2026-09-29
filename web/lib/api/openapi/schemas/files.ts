import { z } from "zod";
import { PART_URL_BATCH_LIMIT } from "@/lib/multipart";
import { fileCategorySchema, fileStatusSchema, isoDateTime } from "./common";

export const createFileBody = z.object({
  s3_bucket: z.string().min(1),
  s3_key: z.string().min(1),
  filename: z.string().min(1),
  content_type: z.string().optional(),
  size_bytes: z.number().optional(),
  category: fileCategorySchema.optional(),
});

// No `s3_bucket` / `s3_key`: the server derives the canonical S3 location on
// the `uploaded` transition, so accepting them from the client only let a
// caller repoint a file at an arbitrary object.
export const patchFileBody = z.object({
  status: fileStatusSchema.optional(),
  // Nullable, not just optional: watchers send an explicit null when the OS
  // has no MIME mapping for the extension (e.g. `.AZE` project files).
  content_type: z.string().nullish(),
  size_bytes: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  error_message: z.string().optional(),
});

// Shared by the create (`formatFileResponse`) and update responses. Create
// omits `detected_at` / `upload_requested_at`, so both are optional here.
export const fileDetail = z
  .object({
    id: z.number().int(),
    instrument_run_id: z.string().uuid(),
    filename: z.string(),
    relative_path: z.string(),
    s3_bucket: z.string().nullable(),
    s3_key: z.string().nullable(),
    content_type: z.string().nullable(),
    size_bytes: z.number().nullable(),
    category: fileCategorySchema,
    status: fileStatusSchema,
    metadata: z.record(z.string(), z.unknown()).nullable(),
    error_message: z.string().nullable(),
    detected_at: isoDateTime.nullable().optional(),
    upload_requested_at: isoDateTime.nullable().optional(),
    uploaded_at: isoDateTime.nullable(),
    processed_at: isoDateTime.nullable(),
    processing_started_at: isoDateTime.nullable(),
    created_at: isoDateTime,
    file_created_at: isoDateTime.nullable(),
  })
  .openapi("FileDetail");

export const fileDismissed = z.object({
  id: z.number().int(),
  filename: z.string(),
  deleted_at: isoDateTime.nullable(),
  already_applied: z.boolean(),
});

export const fileReprocessed = z.object({
  status: z.literal("processing"),
  file_id: z.number().int(),
});

export const multipartPartUrlsBody = z.object({
  upload_id: z.string().min(1),
  part_numbers: z.array(z.number().int()).min(1).max(PART_URL_BATCH_LIMIT),
});

export const multipartPartUrlsResponse = z.object({
  expires_in: z.number().int(),
  parts: z.array(
    z.object({
      part_number: z.number().int(),
      upload_url: z.string().min(1),
    })
  ),
});

export const multipartCompleteBody = z.object({
  upload_id: z.string().min(1),
  checksum_crc64nvme: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  parts: z
    .array(
      z.object({
        part_number: z.number().int(),
        etag: z.string().min(1).max(200),
      })
    )
    .min(1),
});

export const multipartCompleteResponse = z.object({
  file_id: z.number().int(),
  status: z.string(),
  already_uploaded: z.boolean(),
});

export const multipartAbortBody = z.object({
  upload_id: z.string().min(1),
});

export const multipartAbortResponse = z.object({
  file_id: z.number().int(),
  aborted: z.literal(true),
});
