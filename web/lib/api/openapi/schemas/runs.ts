import { z } from "zod";
import {
  fileCategorySchema,
  fileStatusSchema,
  isoDateTime,
  paginationSchema,
  runSourceSchema,
  runStatusSchema,
} from "./common";

export const detectedFileSchema = z.object({
  relative_path: z.string().min(1),
  filename: z.string().min(1),
  size_bytes: z.number().int().nonnegative().optional(),
  file_created_at: isoDateTime.optional(),
});

export const createRunBody = z.object({
  run_id: z.string().min(1),
  source: runSourceSchema,
  watcher_id: z.string().uuid().optional(),
  acquired_at: isoDateTime.optional(),
  detected_files: z.array(detectedFileSchema).optional(),
});

export const patchRunBody = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
  acquired_at: isoDateTime.optional(),
  detected_files: z.array(detectedFileSchema).optional(),
});

export const runListQuery = z.object({
  instrument_id: z.string().optional(),
  source: runSourceSchema.optional(),
  search: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  date_from: isoDateTime.optional(),
  date_to: isoDateTime.optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  include_deleted: z.coerce.boolean().optional(),
  ran_by: z.string().optional(),
  status: z.union([runStatusSchema, z.array(runStatusSchema)]).optional(),
  metadata_key: z
    .string()
    .optional()
    .openapi({ description: "Metadata key filter." }),
  metadata_value: z
    .string()
    .optional()
    .openapi({ description: "Metadata value filter." }),
});

export const fileResponse = z.object({
  id: z.number().int(),
  instrument_run_id: z.string().uuid().optional(),
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
  created_at: isoDateTime,
  download_url: z.string().url().nullable().optional(),
});

export const runListItem = z.object({
  id: z.string().uuid(),
  instrument_id: z.string(),
  instrument_display_name: z.string().nullable().optional(),
  run_id: z.string(),
  source: runSourceSchema,
  status: runStatusSchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
  acquired_at: isoDateTime.nullable(),
  created_at: isoDateTime,
});

export const runListResponse = z.object({
  data: z.array(runListItem),
  pagination: paginationSchema,
});

export const runDetail = runListItem.extend({
  watcher_id: z.string().uuid().nullable(),
  updated_at: isoDateTime,
  deleted_at: isoDateTime.nullable(),
  deleted_by: z.string().nullable(),
  attributions: z.array(z.unknown()),
  files: z.array(fileResponse),
});

export const requestUploadBody = z.object({
  file_ids: z.array(z.union([z.string(), z.number()])),
});
export const requestUploadUrlBody = z.object({
  filename: z.string().min(1),
  content_type: z.string().optional(),
  size_bytes: z.number().optional(),
  file_created_at: isoDateTime.optional(),
});
export const commentBody = z.object({ body: z.string().min(1).max(10_000) });
