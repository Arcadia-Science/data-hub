import { z } from "zod";
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
// caller repoint a file at an arbitrary object (ENG-1450).
export const patchFileBody = z.object({
  status: fileStatusSchema.optional(),
  content_type: z.string().optional(),
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
