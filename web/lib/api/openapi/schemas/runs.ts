import { z } from "zod";
import {
  fileCategorySchema,
  fileStatusSchema,
  isoDateTime,
  paginationSchema,
  runSourceSchema,
  runStatusSchema,
} from "./common";

// Rejects path traversal in watcher-reported file locations. The watcher
// joins these onto its watch directory and reads the result, so an
// unchecked `..` segment or absolute path lets a malicious run exfiltrate
// arbitrary files from the instrument PC (ENG-1452). Watchers run on
// Windows too, hence we also reject `\` and drive paths, not just `/`.
function isSafeRelativePath(value: string): boolean {
  if (value.includes("\0")) {
    return false;
  }
  // Absolute: POSIX `/foo`, Windows UNC/drive-relative `\foo`, or drive
  // paths like `C:\foo`/`C:foo`.
  if (/^([/\\]|[a-zA-Z]:)/.test(value)) {
    return false;
  }
  // Any `..` segment (either separator) can escape the watch directory.
  return !value.split(/[/\\]/).includes("..");
}

const safeRelativePath = z.string().min(1).refine(isSafeRelativePath, {
  message:
    "must be a relative path without '..' segments, absolute prefixes, or null bytes",
});

export const detectedFileSchema = z.object({
  relative_path: safeRelativePath,
  filename: safeRelativePath,
  size_bytes: z.number().int().nonnegative().optional(),
  file_created_at: isoDateTime.optional(),
});

export const createRunBody = z.object({
  run_id: z.string().trim().min(1),
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

const metadataObject = z.record(z.string(), z.unknown());

// A user who has claimed a run. Wire shape mixes `userId` with camelCase
// display fields — mirror it exactly rather than "fixing" the casing here.
export const attribution = z
  .object({
    userId: z.string(),
    displayName: z.string(),
    initials: z.string(),
    avatarUrl: z.string().nullable(),
  })
  .openapi("RunAttribution");

export const runCreated = z
  .object({
    id: z.string().uuid(),
    instrument_id: z.string(),
    run_id: z.string(),
    source: runSourceSchema,
  })
  .openapi("RunCreated");

export const runUpdated = z
  .object({
    id: z.string().uuid(),
    instrument_id: z.string(),
    instrument_display_name: z.string().nullable(),
    run_id: z.string(),
    source: runSourceSchema,
    watcher_id: z.string().uuid().nullable(),
    metadata: metadataObject.nullable(),
    created_at: isoDateTime,
    acquired_at: isoDateTime.nullable(),
    updated_at: isoDateTime,
    deleted_at: isoDateTime.nullable(),
  })
  .openapi("RunUpdated");

// File sub-object embedded in run detail. Distinct from the top-level file
// resource: it carries a presigned `download_url` and omits `s3_bucket`.
export const runDetailFile = z
  .object({
    id: z.number().int(),
    filename: z.string(),
    relative_path: z.string(),
    s3_key: z.string().nullable(),
    content_type: z.string().nullable(),
    size_bytes: z.number().nullable(),
    category: fileCategorySchema,
    status: fileStatusSchema,
    metadata: metadataObject.nullable(),
    error_message: z.string().nullable(),
    detected_at: isoDateTime.nullable(),
    upload_requested_at: isoDateTime.nullable(),
    uploaded_at: isoDateTime.nullable(),
    processed_at: isoDateTime.nullable(),
    download_url: z.string().url().nullable(),
    created_at: isoDateTime,
    file_created_at: isoDateTime.nullable(),
  })
  .openapi("RunDetailFile");

export const runDetail = z
  .object({
    id: z.string().uuid(),
    instrument_id: z.string(),
    instrument_display_name: z.string().nullable(),
    run_id: z.string(),
    source: runSourceSchema,
    watcher_id: z.string().uuid().nullable(),
    created_at: isoDateTime,
    acquired_at: isoDateTime.nullable(),
    updated_at: isoDateTime,
    deleted_at: isoDateTime.nullable(),
    deleted_by: z.string().nullable(),
    metadata: metadataObject.nullable(),
    attributions: z.array(attribution),
    files: z.array(runDetailFile),
  })
  .openapi("RunDetail");

export const runListItem = z
  .object({
    id: z.string().uuid(),
    instrument_id: z.string(),
    instrument_display_name: z.string().nullable(),
    run_id: z.string(),
    source: runSourceSchema,
    metadata: metadataObject.nullable(),
    created_at: isoDateTime,
    acquired_at: isoDateTime.nullable(),
    updated_at: isoDateTime,
    deleted_at: isoDateTime.nullable(),
    file_count: z.number().int(),
    files_completed: z.number().int(),
    files_failed: z.number().int(),
    files_pending_upload: z.number().int(),
    files_uploaded: z.number().int(),
    files_processing: z.number().int(),
    // Aggregated with a `bigint` cast, which the driver may surface as a
    // string on large totals.
    total_size_bytes: z.union([z.number(), z.string()]),
    error_messages: z.array(z.string()),
    attributions: z.array(attribution),
  })
  .openapi("RunListItem");

export const runListResponse = z.object({
  data: z.array(runListItem),
  pagination: paginationSchema,
});

export const runDeleted = z.object({
  instrument_id: z.string(),
  run_id: z.string(),
  deleted_at: isoDateTime.nullable(),
  deleted_by: z.string().nullable(),
  already_applied: z.boolean(),
});

export const runRestored = z.object({
  id: z.string().uuid(),
  instrument_id: z.string(),
  run_id: z.string(),
  deleted_at: isoDateTime.nullable(),
  already_applied: z.boolean(),
});

export const runReprocessed = z.object({
  instrument_id: z.string(),
  run_id: z.string(),
  files_queued: z.number().int(),
  files_failed: z.number().int(),
});

export const requestUploadBody = z.object({
  file_ids: z.array(z.union([z.string(), z.number()])).min(1),
});
export const requestUploadUrlBody = z.object({
  filename: z.string().min(1),
  content_type: z.string().optional(),
  size_bytes: z.number().optional(),
  file_created_at: isoDateTime.optional(),
});
export const commentBody = z.object({ body: z.string().min(1).max(10_000) });

export const uploadQueued = z.object({
  instrument_id: z.string(),
  run_id: z.string(),
  files_queued: z.number().int(),
  files: z
    .array(
      z.object({
        id: z.number().int(),
        filename: z.string(),
        upload_requested_at: isoDateTime.nullable(),
      })
    )
    .optional(),
});

export const uploadAllQueued = z.object({
  instrument_id: z.string(),
  run_id: z.string(),
  files_queued: z.number().int(),
});

export const uploadUrlResponse = z
  .union([
    z.object({
      already_uploaded: z.literal(true),
      file_id: z.number().int(),
      s3_bucket: z.string().nullable(),
      s3_key: z.string().nullable(),
    }),
    z.object({
      already_uploaded: z.literal(false),
      upload_url: z.string().url(),
      s3_bucket: z.string(),
      s3_key: z.string(),
      file_id: z.number().int(),
      expires_in: z.number().int(),
    }),
  ])
  .openapi("UploadUrlResponse");

export const attributionsResponse = z.object({
  attributions: z.array(attribution),
});

const commentUser = z.object({
  id: z.string(),
  displayName: z.string(),
  initials: z.string(),
  avatarUrl: z.string().nullable(),
});

export const runComment = z
  .object({
    id: z.string().uuid(),
    body: z.string(),
    user: commentUser,
    created_at: isoDateTime,
    edited_at: isoDateTime.nullable(),
  })
  .openapi("RunComment");

export const commentsListResponse = z.object({
  comments: z.array(runComment),
});

export const commentDeleted = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
