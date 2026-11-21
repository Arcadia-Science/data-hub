import { z } from "zod";
import { PART_URL_BATCH_LIMIT } from "@/lib/multipart";
import { FILE_ACTION_IDS_MAX } from "@/lib/runs/file-action-limits";
import {
  fileCategorySchema,
  fileStatusSchema,
  isoDateTime,
  linkedFileRelationSchema,
} from "./common";
import { tokenActor } from "./runs";

export const createFileBody = z.object({
  s3_bucket: z.string().min(1),
  s3_key: z.string().min(1),
  filename: z.string().min(1),
  content_type: z.string().optional(),
  size_bytes: z.number().optional(),
  category: fileCategorySchema.optional(),
  // The raw file of this run that a processed file was made from. Deleting the
  // raw file offers to delete this file with it, and a processed file made from
  // a deleted raw file is saved deleted. Only for `processed` files.
  source_file_id: z.number().int().positive().optional(),
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
    // Set when the file is deleted. A deleted file keeps its row and its stored
    // object, and refuses changes (`409`, `details.reason: file_deleted`).
    deleted_at: isoDateTime.nullable(),
  })
  .openapi("FileDetail");

// The error a file that couldn't be changed reports, in the shape of an HTTP
// error body.
const fileActionError = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// One file's result when several are deleted or restored. A failure carries the
// status its own request would have answered with.
const failureFields = {
  ok: z.literal(false),
  id: z.number().int(),
  filename: z
    .string()
    .nullable()
    .describe("The file's name, or null when there is no such file."),
  status: z.number().int().describe("`404` or `409`."),
  error: fileActionError,
};

const fileActionFailure = z.object(failureFields).openapi("FileActionFailure");

// At most one of `deleted_by` and `deleted_by_token` is set: the person or the
// token that deleted the file, the way a run reports its deleter. Both are null
// for a file deleted before Data Hub recorded who did it.
const deletedFileFields = {
  id: z.number().int(),
  filename: z.string(),
  deleted_at: isoDateTime,
  deleted_by: z.string().nullable().openapi({
    description: "The user ID of the person who deleted the file.",
  }),
  deleted_by_token: tokenActor.nullable(),
  already_applied: z.boolean().openapi({
    description:
      "True when the file was already deleted, so nothing changed. `deleted_at` and the deleter are then the first delete's.",
  }),
};

const restoredFileFields = {
  id: z.number().int(),
  filename: z.string(),
  deleted_at: z.null(),
  already_applied: z.boolean().openapi({
    description: "True when the file wasn't deleted, so nothing changed.",
  }),
};

const fileDeleteResult = z
  .union([
    z.object({ ok: z.literal(true), ...deletedFileFields }),
    fileActionFailure,
  ])
  .openapi("FileDeleteResult");

const fileRestoreResult = z
  .union([
    z.object({ ok: z.literal(true), ...restoredFileFields }),
    fileActionFailure,
  ])
  .openapi("FileRestoreResult");

const linkedRelation = linkedFileRelationSchema.describe(
  "How the linked file relates to the file it came with. `video`, `preview_image` and `output` are files made from a raw file, `sidecar` is the `run.json` saved with its capture, and `made_from` is the raw file a processed file was made from (restoring only)."
);

const linkedDelete = z
  .object({
    ok: z.literal(true),
    id: z.number().int(),
    filename: z.string(),
    relation: linkedRelation,
    already_applied: z.literal(false),
    deleted_at: isoDateTime,
  })
  .openapi("LinkedFileDeleted");

const linkedRestore = z
  .union([
    z.object({
      ok: z.literal(true),
      ...restoredFileFields,
      relation: linkedRelation,
    }),
    z.object({ ...failureFields, relation: linkedRelation }),
  ])
  .openapi("LinkedFileRestored");

export const fileDeleted = z
  .object({
    ...deletedFileFields,
    linked: z.array(linkedDelete).openapi({
      description:
        "The files deleted with this one, when `include_linked=true`. Files that were already deleted aren't listed.",
    }),
  })
  .openapi("FileDeleted");

export const fileRestored = z
  .object({
    ...restoredFileFields,
    linked: z.array(linkedRestore).openapi({
      description:
        "The deleted files restored with this one, when `include_linked=true`, and the ones that couldn't be.",
    }),
  })
  .openapi("FileRestored");

// Delete and restore take the same body.
export const fileActionBody = z.object({
  file_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(FILE_ACTION_IDS_MAX)
    .openapi({
      description: `IDs of files in this run, 1 to ${FILE_ACTION_IDS_MAX}. A repeated ID is handled once. An ID that isn't a file of this run gets a \`404\` result.`,
    }),
  include_linked: z.boolean().optional().openapi({
    description:
      "Also delete (or restore) the files linked to these. Default false.",
  }),
});

export const fileActionQuery = z.object({
  include_linked: z.enum(["true", "false"]).optional().openapi({
    description:
      "`true` also deletes (or restores) the files linked to this one. Default `false`.",
  }),
});

const count = z.number().int();

export const runFilesDeleted = z
  .object({
    instrument_id: z.string(),
    run_id: z.string(),
    results: z.array(fileDeleteResult).openapi({
      description:
        "One result per file, in the order sent, repeated IDs dropped. A file that can't be deleted has `ok: false` and doesn't stop the others.",
    }),
    linked: z.array(linkedDelete).openapi({
      description:
        "The files deleted along with the requested ones, when `include_linked` was true.",
    }),
    counts: z.object({
      deleted: count,
      already_deleted: count,
      failed: count,
    }),
  })
  .openapi("RunFilesDeleted");

export const runFilesRestored = z
  .object({
    instrument_id: z.string(),
    run_id: z.string(),
    results: z.array(fileRestoreResult).openapi({
      description:
        "One result per file, in the order sent, repeated IDs dropped. A file that can't come back has `ok: false` and doesn't stop the others.",
    }),
    linked: z.array(linkedRestore).openapi({
      description:
        "The deleted files restored along with the requested ones, when `include_linked` was true, and the ones that couldn't be.",
    }),
    counts: z.object({
      restored: count,
      already_restored: count,
      failed: count,
    }),
  })
  .openapi("RunFilesRestored");

export const runFilesLinkedQuery = z.object({
  file_ids: z.string().openapi({
    description: `Comma-separated file IDs, 1 to ${FILE_ACTION_IDS_MAX}. An ID that isn't a file of this run is left out.`,
    example: "12,13",
  }),
  for: z.enum(["delete", "restore"]).optional().openapi({
    description:
      "`delete` (the default) lists the active files a delete would take along. `restore` lists the deleted files a restore would bring back.",
  }),
});

const linkedFile = z
  .object({
    id: z.number().int(),
    filename: z.string(),
    size_bytes: z.number().nullable(),
    category: fileCategorySchema,
    relation: linkedRelation,
    deleted_at: isoDateTime.nullable(),
  })
  .openapi("LinkedFile");

export const runFilesLinked = z
  .object({
    instrument_id: z.string(),
    run_id: z.string(),
    groups: z
      .array(
        z.object({
          file_id: z.number().int(),
          linked: z.array(linkedFile),
        })
      )
      .openapi({
        description:
          "The linked files of each file asked about. A file with none is left out. A file linked to several of them, such as a `run.json` shared by the raw files of one folder, is listed under each.",
      }),
  })
  .openapi("RunFilesLinked");

export const fileReprocessed = z.object({
  // `processing` when the file started right away, `queued` when it is
  // waiting for a free processing slot.
  status: z.enum(["processing", "queued"]),
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
