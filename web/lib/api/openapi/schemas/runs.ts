import { z } from "zod";
import {
  NOTEBOOK_LINK_BULK_RUNS_MAX,
  NOTEBOOK_LINK_BULK_URLS_MAX,
  notebookLinkLabelInputSchema,
  notebookLinkUrlSchema,
} from "@/lib/notebook-links/url";
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
  runStatusSchema,
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
  status: z.union([runStatusSchema, z.array(runStatusSchema)]).optional(),
  has_notebook_link: z.enum(["true", "false"]).optional().openapi({
    description:
      "`true` lists only runs with at least one lab notebook link; `false` lists only runs with none.",
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

const notebookLinkUser = z.object({
  id: z.string(),
  displayName: z.string(),
  initials: z.string(),
  avatarUrl: z.string().nullable(),
});

export const notebookLink = z
  .object({
    id: z.string().uuid(),
    url: z.string().openapi({
      description: "The link as saved, ready to open.",
    }),
    url_key: z.string().openapi({
      description:
        "Two links with the same key point to the same page. The key ignores http vs. https, `www.`, a trailing slash, the fragment, and tracking parameters. Notion links are keyed by page ID, so a renamed page still matches.",
    }),
    label: z.string().nullable(),
    display_name: z.string().openapi({
      description:
        "The label, or a name worked out from the URL when there is none.",
    }),
    created_at: isoDateTime,
    // At most one of `created_by` and `created_by_token` is set: the person
    // or token that added the link. Both are null once that person is deleted.
    created_by: notebookLinkUser.nullable(),
    created_by_token: tokenActor.nullable(),
    updated_at: isoDateTime,
    updated_by: notebookLinkUser.nullable(),
    updated_by_token: tokenActor.nullable(),
  })
  .openapi("RunNotebookLink");

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
    error_message: z.string().nullable(),
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
    notebook_links: z.array(notebookLink),
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
    files_pending_upload: z.number().int(),
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
    notebook_links: z.array(notebookLink),
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

export const notebookLinksListResponse = z.object({
  notebook_links: z.array(notebookLink),
});

export const createNotebookLinkBody = z.object({
  url: notebookLinkUrlSchema,
  label: notebookLinkLabelInputSchema.nullable().optional().openapi({
    description: "Optional name for the link. Blank or null means none.",
  }),
});

export const updateNotebookLinkBody = z
  .object({
    url: notebookLinkUrlSchema.optional(),
    label: notebookLinkLabelInputSchema.nullable().optional().openapi({
      description: "Null or blank clears the label. Leave it out to keep it.",
    }),
  })
  .refine((body) => body.url !== undefined || body.label !== undefined, {
    message: "Send url, label, or both",
  });

export const notebookLinkDeleted = z.object({
  id: z.string().uuid(),
  deleted: z.literal(true),
});

const bulkRunRef = z.object({
  instrument_id: z.string().min(1),
  run_id: z.string().min(1),
});

const bulkRuns = z
  .array(bulkRunRef)
  .min(1)
  .max(NOTEBOOK_LINK_BULK_RUNS_MAX)
  .openapi({
    description: `The runs to change, at most ${NOTEBOOK_LINK_BULK_RUNS_MAX}. They can belong to different instruments.`,
  });

export const bulkAddNotebookLinkBody = z.object({
  runs: bulkRuns,
  url: notebookLinkUrlSchema,
  label: notebookLinkLabelInputSchema.nullable().optional().openapi({
    description:
      "Optional name for the new links. Runs that already link to the page keep their own label.",
  }),
});

export const bulkAddNotebookLinkResult = z.object({
  url: z.string(),
  url_key: z.string(),
  results: z.array(
    z.object({
      instrument_id: z.string(),
      run_id: z.string(),
      outcome: z
        .enum([
          "added",
          "already_linked",
          "run_deleted",
          "limit_reached",
          "not_found",
        ])
        .openapi({
          description:
            "`already_linked`: the run already links to the same page and was left as it was. `limit_reached`: the run already has the most links allowed.",
        }),
      link: notebookLink.nullable().openapi({
        description:
          "The run's link to the page, for `added` and `already_linked`.",
      }),
    })
  ),
  counts: z.object({
    added: z.number().int(),
    already_linked: z.number().int(),
    run_deleted: z.number().int(),
    limit_reached: z.number().int(),
    not_found: z.number().int(),
  }),
});

export const bulkRemoveNotebookLinksBody = z.object({
  runs: bulkRuns,
  urls: z
    .array(notebookLinkUrlSchema)
    .min(1)
    .max(NOTEBOOK_LINK_BULK_URLS_MAX)
    .openapi({
      description:
        "Links to remove. Each removes any link to the same page, so a copy of the URL with a different query string or `www.` still matches.",
    }),
});

export const bulkRemoveNotebookLinksResult = z.object({
  url_keys: z.array(z.string()),
  results: z.array(
    z.object({
      instrument_id: z.string(),
      run_id: z.string(),
      outcome: z.enum(["removed", "not_linked", "run_deleted", "not_found"]),
      removed: z.number().int(),
    })
  ),
  counts: z.object({
    removed: z.number().int(),
    not_linked: z.number().int(),
    run_deleted: z.number().int(),
    not_found: z.number().int(),
  }),
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
