import { z } from "zod";
import {
  fileCategorySchema,
  fileStatusSchema,
  instrumentTypeSchema,
  isoDateTime,
  paginationSchema,
  runSourceSchema,
} from "@/lib/api/openapi/schemas/common";
import { mcpActorUserSchema } from "./common.output";

// Plain Zod only — do not import from openapi/schemas/runs (those use
// `.openapi()` and require registry side effects that unit tests skip).

/** Trimmed file row from `toMcpFile` after JSON round-trip. */
export const mcpRunFileSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  relativePath: z.string().nullable(),
  category: fileCategorySchema,
  status: fileStatusSchema,
  sizeBytes: z.number().nullable(),
  contentType: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: isoDateTime,
  uploadedAt: isoDateTime.nullable(),
  processedAt: isoDateTime.nullable(),
  stalled: z.boolean(),
});

/** Failure summary attached via `get_run` include=failure_summary / report. */
export const mcpFailureSummarySchema = z.object({
  byStatus: z.record(z.string(), z.number().int()),
  failed: z.array(
    z.object({
      id: z.number().int(),
      filename: z.string(),
      errorMessage: z.string().nullable(),
    })
  ),
  totalFiles: z.number().int(),
});

export const mcpRunCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  user: z.object({
    id: z.string(),
    displayName: z.string(),
    initials: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  created_at: isoDateTime,
  edited_at: isoDateTime.nullable(),
});

/**
 * `search_runs` list rows use underscored SQL aliases (not camelCase), with
 * camelCase `attributions` nested — match that mixed casing exactly.
 */
export const searchRunsListItemSchema = z.object({
  id: z.string().uuid(),
  instrument_id: z.string(),
  instrument_display_name: z.string().nullable(),
  instrument_type: instrumentTypeSchema,
  run_id: z.string(),
  source: runSourceSchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
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
  // Aggregated with a bigint cast; drivers may surface large totals as strings.
  total_size_bytes: z.union([z.number(), z.string()]),
  error_messages: z.array(z.string()),
  attributions: z.array(mcpActorUserSchema),
});

export const searchRunsOutputSchema = z.object({
  data: z.array(searchRunsListItemSchema),
  pagination: paginationSchema,
});

export const getRunOutputSchema = z.object({
  id: z.string().uuid(),
  instrumentId: z.string(),
  runId: z.string(),
  source: runSourceSchema,
  watcherId: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  acquiredAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  deletedAt: isoDateTime.nullable(),
  deletedBy: z.string().nullable(),
  instrumentDisplayName: z.string(),
  instrumentType: instrumentTypeSchema,
  deletedByUser: mcpActorUserSchema.nullable(),
  attributions: z.array(mcpActorUserSchema),
  files: z.array(mcpRunFileSchema).optional(),
  filesPagination: paginationSchema.optional(),
  comments: z.array(mcpRunCommentSchema).optional(),
  failureSummary: mcpFailureSummarySchema.optional(),
});

const reportFileRefSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  category: fileCategorySchema,
  contentType: z.string().nullable(),
  status: fileStatusSchema,
  sizeBytes: z.number().nullable(),
});

export const getRunReportOutputSchema = z.object({
  instrumentId: z.string(),
  runId: z.string(),
  instrumentType: z.string(),
  metadata: z.unknown(),
  fileCounts: z.record(z.string(), z.number().int()),
  processedCsv: z
    .object({
      rowCount: z.number().int(),
      columns: z.array(z.string()),
      sampleRows: z.array(z.record(z.string(), z.string())),
      sampleRowLimit: z.number().int(),
      truncated: z.boolean(),
    })
    .nullable(),
  images: z.array(reportFileRefSchema),
  reportFiles: z.array(reportFileRefSchema),
  failureSummary: mcpFailureSummarySchema,
});

export const listRunFilesOutputSchema = z.object({
  data: z.array(mcpRunFileSchema),
  pagination: paginationSchema,
});

export const claimRunOutputSchema = z.object({
  instrumentId: z.string(),
  runId: z.string(),
  attributions: z.array(mcpActorUserSchema),
});

export const claimRunsOutputSchema = z.object({
  instrumentId: z.string(),
  claimed: z.array(
    z.object({
      runId: z.string(),
      attributions: z.array(mcpActorUserSchema),
    })
  ),
  notFound: z.array(z.string()),
});

export const unclaimRunOutputSchema = claimRunOutputSchema;

/** Object wrapper for 2025-era wire compat (bare arrays get `{ result }` wrapping). */
export const listRunAttributorsOutputSchema = z.object({
  attributors: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string(),
    })
  ),
});

export const listRunCommentsOutputSchema = z.object({
  comments: z.array(mcpRunCommentSchema),
});

export const addRunCommentOutputSchema = mcpRunCommentSchema;
export const editRunCommentOutputSchema = mcpRunCommentSchema;

export const deleteRunCommentOutputSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});

export const reprocessRunOutputSchema = z.object({
  instrumentId: z.string(),
  runId: z.string(),
  filesQueued: z.number().int(),
  filesFailed: z.number().int(),
});

export const deleteRunOutputSchema = z.object({
  instrumentId: z.string(),
  runId: z.string(),
  deletedAt: isoDateTime.nullable(),
  deletedBy: z.string().nullable(),
  alreadyApplied: z.boolean(),
});

export const restoreRunOutputSchema = z.object({
  instrumentId: z.string(),
  runId: z.string(),
  deletedAt: isoDateTime.nullable(),
  alreadyApplied: z.boolean(),
});

export const requestRunUploadOutputSchema = z.object({
  instrumentId: z.string(),
  runId: z.string(),
  filesQueued: z.number().int(),
  files: z.array(
    z.object({
      id: z.number().int(),
      filename: z.string(),
      uploadRequestedAt: isoDateTime.nullable(),
    })
  ),
});

export const requestRunUploadAllOutputSchema = z.object({
  instrumentId: z.string(),
  runId: z.string(),
  filesQueued: z.number().int(),
});
