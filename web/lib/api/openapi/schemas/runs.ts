import { z } from "zod";
import {
  REPORT_ITEM_KINDS,
  REPORT_ITEMS_MAX_LIMIT,
} from "@/lib/runs/report-items";
import {
  fileCategorySchema,
  fileStatusSchema,
  instrumentTypeSchema,
  isoDateTime,
  paginationSchema,
  runSourceSchema,
  runStatusFilterSchema,
  uploadFailureReasonSchema,
} from "./common";

// Rejects path traversal in watcher-reported file locations. The watcher
// joins these onto its watch directory and reads the result, so an
// unchecked `..` segment or absolute path lets a malicious run exfiltrate
// arbitrary files from the instrument PC. Watchers run on
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
  // Sent by watcher 1.4.5 and later. Leave it out when someone has to request
  // the file, for example in manual mode.
  will_upload: z.boolean().optional().openapi({
    description:
      "True when the watcher will upload this file on its own (auto mode). The file then reads as waiting to upload rather than not uploaded. Leave it out, or send false, when someone has to request the upload.",
  }),
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
  sort: z.string().optional().openapi({
    description:
      "Sort field: acquired_at (default; when the run started, falling back to created_at), created_at, or updated_at (the last change to the run or any of its files).",
  }),
  order: z.enum(["asc", "desc"]).optional(),
  date_from: isoDateTime.optional(),
  date_to: isoDateTime.optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  include_deleted: z.coerce.boolean().optional(),
  ran_by: z.string().optional(),
  status: z
    .union([runStatusFilterSchema, z.array(runStatusFilterSchema)])
    .optional()
    .openapi({
      description:
        "Derived run status. Several values (repeated, or comma-separated) match any of them. `pending` is deprecated: it matches `waiting_upload` and `not_uploaded`, and no run reports it.",
    }),
  has_lab_notebook: z.enum(["true", "false"]).optional().openapi({
    description:
      "`true` lists only runs in at least one lab notebook; `false` lists only runs in none. Deleted lab notebooks don't count.",
  }),
  lab_notebook_id: z.string().optional().openapi({
    description:
      "Lists only runs in this lab notebook. A deleted lab notebook still lists its runs. A blank value is ignored, and an ID that matches no lab notebook matches no runs.",
  }),
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

// A personal access token that acted on its own, shown beside the `*_by`
// user field it replaces for that row.
export const tokenActor = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .openapi("TokenActor");

// A person as notebooks name them: who owns, created, changed, or deleted
// one, or who added a run to it.
export const notebookUser = z.object({
  id: z.string(),
  displayName: z.string(),
  initials: z.string(),
  avatarUrl: z.string().nullable(),
});

export const notebookUrlKey = z.string().openapi({
  description:
    "Two links with the same key point to the same page. The key ignores http vs. https, `www.`, a trailing slash, the fragment, and tracking parameters. Notion links are keyed by page ID, so a renamed page still matches.",
});

// A lab notebook as a run lists it. Deleted notebooks are left out.
export const runNotebook = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    url: z.string().openapi({
      description: "The lab notebook's page, ready to open.",
    }),
    url_key: notebookUrlKey,
    linked_at: isoDateTime.describe(
      "When the run was added to the lab notebook."
    ),
    // At most one of `linked_by` and `linked_by_token` is set: the person or
    // token that added the run. Both are null once that person is deleted.
    linked_by: notebookUser.nullable(),
    linked_by_token: tokenActor.nullable(),
  })
  .openapi("RunLabNotebook");

export const runCreated = z
  .object({
    id: z.string().uuid(),
    instrument_id: z.string(),
    run_id: z.string(),
    source: runSourceSchema,
    metadata: metadataObject.openapi({
      description:
        "The run's stored metadata. Empty for a new run; an existing run returns what processing has written so far.",
    }),
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
    error_message: z.string().nullable().openapi({
      description:
        "Why processing failed (`failed`) or why the watcher couldn't upload the file (`upload_failed`).",
    }),
    upload_failure_reason: uploadFailureReasonSchema.nullable().openapi({
      description:
        "Set when the status is `upload_failed`: `folder_missing`, `file_missing`, `upload_error` or `unsafe_path`.",
    }),
    upload_failed_at: isoDateTime.nullable(),
    detected_at: isoDateTime.nullable(),
    upload_requested_at: isoDateTime.nullable(),
    uploaded_at: isoDateTime.nullable(),
    processed_at: isoDateTime.nullable(),
    processing_started_at: isoDateTime.nullable(),
    download_url: z.string().url().nullable(),
    created_at: isoDateTime,
    file_created_at: isoDateTime.nullable(),
    deleted_at: isoDateTime.nullable(),
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
    deleted_by_token: tokenActor.nullable(),
    metadata: metadataObject.nullable(),
    attributions: z.array(attribution),
    lab_notebooks: z.array(runNotebook).openapi({
      description:
        "The run's lab notebooks, in the order the run was added to them.",
    }),
    files: z.array(runDetailFile),
  })
  .openapi("RunDetail");

export const runListItem = z
  .object({
    id: z.string().uuid(),
    instrument_id: z.string(),
    instrument_display_name: z.string().nullable(),
    instrument_type: instrumentTypeSchema,
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
    files_upload_failed: z.number().int().openapi({
      description: "Files the watcher gave up on (`upload_failed`).",
    }),
    files_waiting_upload: z.number().int().openapi({
      description:
        "Files on their way from the instrument PC: requested, or ones the watcher uploads on its own.",
    }),
    files_not_uploaded: z.number().int().openapi({
      description:
        "Files only on the instrument PC that nothing will upload until someone requests them.",
    }),
    files_pending_upload: z.number().int().openapi({
      description:
        "Deprecated: `files_waiting_upload` plus `files_not_uploaded`.",
      deprecated: true,
    }),
    files_uploaded: z.number().int(),
    files_queued: z.number().int(),
    // `files_processing` counts only files still inside the stall window;
    // ones past it are in `files_stalled`.
    files_processing: z.number().int(),
    files_stalled: z.number().int(),
    // Aggregated with a `bigint` cast, which the driver may surface as a
    // string on large totals.
    total_size_bytes: z.union([z.number(), z.string()]),
    error_messages: z.array(z.string()),
    attributions: z.array(attribution),
    comment_count: z.number().int(),
    lab_notebooks: z.array(runNotebook).openapi({
      description:
        "The run's lab notebooks, in the order the run was added to them.",
    }),
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
  deleted_by_token: tokenActor.nullable(),
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
  // Files accepted: started right away, or waiting as `queued`.
  files_queued: z.number().int(),
  files_failed: z.number().int(),
});

export const runQueuedCancelled = z.object({
  instrument_id: z.string(),
  run_id: z.string(),
  // Queued files that became `failed`. Zero when none were queued.
  files_cancelled: z.number().int(),
});

export const requestUploadBody = z.object({
  file_ids: z.array(z.union([z.string(), z.number()])).min(1),
});
export const requestUploadUrlBody = z.object({
  // Persisted as `relative_path` when the watcher sends none, and joined
  // into the S3 key, so it gets the same path-traversal check.
  filename: safeRelativePath,
  // Folder path the watcher will read. Sent by watchers that can upload a
  // renamed file, so a second copy of `filename` from another folder gets
  // its own row instead of the one this name already belongs to.
  relative_path: safeRelativePath.optional(),
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
    z.object({
      already_uploaded: z.literal(false),
      upload_type: z.literal("multipart"),
      upload_id: z.string(),
      part_size: z.number().int(),
      part_count: z.number().int(),
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
    // Exactly one of `user` and `token` is set: a person, or the personal
    // access token that posted the comment through the API.
    user: commentUser.nullable(),
    token: tokenActor.nullable(),
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

export const reportItemsQuery = z.object({
  kind: z.enum(REPORT_ITEM_KINDS).openapi({
    description:
      "Which renderable artifacts to list. `media` lists videos and images together, and leaves out an image whose video has the same name, because that image is the video's poster.",
  }),
  search: z.string().optional().openapi({
    description: "Case-insensitive filename substring filter.",
  }),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(REPORT_ITEMS_MAX_LIMIT).optional(),
  anchor: z.coerce.number().int().positive().optional().openapi({
    description:
      "File id to centre the window on. Overrides `offset` and returns the item's position as `anchor_index`.",
  }),
});

export const reportItem = z
  .object({
    id: z.number().int(),
    filename: z.string(),
    poster_id: z.number().int().nullable().optional().openapi({
      description:
        "Only for `kind=media`. The file id of the image with the same name as this video, used as its poster. Null for an image, or for a video without one.",
    }),
  })
  .openapi("ReportItem");

export const reportItemsResponse = z.object({
  data: z.array(reportItem),
  pagination: z.object({
    offset: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    anchor_index: z.number().int().nullable().optional(),
  }),
});
