import { z } from "zod";
import {
  fileCategorySchema,
  fileStatusSchema,
  isoDateTime,
  linkedFileRelationSchema,
  uploadFailureReasonSchema,
} from "@/lib/api/openapi/schemas/common";
import { mcpActorTokenSchema } from "./common.output";

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
  uploadFailureReason: uploadFailureReasonSchema.nullable(),
  uploadFailedAt: isoDateTime.nullable(),
  uploadRequestedBy: z.string().nullable(),
  autoUploadExpectedAt: isoDateTime.nullable(),
  detectedAt: isoDateTime.nullable(),
  uploadRequestedAt: isoDateTime.nullable(),
  uploadedAt: isoDateTime.nullable(),
  processedAt: isoDateTime.nullable(),
  processingStartedAt: isoDateTime.nullable(),
  queuedAt: isoDateTime.nullable(),
  fileCreatedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  // Set when the file is deleted. A deleted file is still returned by its ID.
  deletedAt: isoDateTime.nullable(),
  // The user ID of the person who deleted the file, or the token that did, as
  // list_run_files reports them. Both are null for an active file, and for a
  // file deleted before Data Hub recorded who did it.
  deletedBy: z.string().nullable(),
  deletedByToken: mcpActorTokenSchema.nullable(),
  stalled: z.boolean(),
});

// True when nobody has claimed the run and it isn't deleted.
const unclaimedSchema = z.boolean();

export const getFileDownloadUrlOutputSchema = z.object({
  fileId: z.number().int(),
  filename: z.string(),
  downloadUrl: z.string(),
  expiresInSeconds: z.number().int(),
  // The file's run, for `claim_run`.
  instrumentId: z.string(),
  runId: z.string(),
  unclaimed: unclaimedSchema,
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
    unclaimed: unclaimedSchema,
  }),
  z.object({
    status: z.literal("building"),
    instrumentId: z.string(),
    runId: z.string(),
    jobId: z.string(),
    retryAfterSeconds: z.number().int(),
    hint: z.string(),
    unclaimed: unclaimedSchema,
  }),
]);

export const reprocessFileOutputSchema = z.object({
  // `processing` when the file started right away, `queued` when it is
  // waiting for a free processing slot.
  status: z.enum(["processing", "queued"]),
  fileId: z.number().int(),
});

export const dismissFileOutputSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  deletedAt: isoDateTime,
  alreadyApplied: z.boolean(),
});

// One file's result when several are deleted or restored. A failure that stops
// one file leaves the others alone, so it sits in the list, not in an error.
const fileFailureSchema = z.object({
  ok: z.literal(false),
  id: z.number().int(),
  // The file's name, or null when there is no such file in the run.
  filename: z.string().nullable(),
  // 404, or 409 when the file is queued or processing, the run is deleted, or
  // another file now holds the name or path of a file being restored.
  status: z.number().int(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    // `reason` tells the conflicts apart (`file_processing`, `run_deleted`,
    // `path_in_use`). `held_by` names the file that holds a restored file's
    // path.
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

const deleteResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    id: z.number().int(),
    filename: z.string(),
    deletedAt: isoDateTime,
    // The user ID of the person who deleted the file, or the token that did.
    // Both are null for a file deleted before Data Hub recorded who did it.
    deletedBy: z.string().nullable(),
    deletedByToken: mcpActorTokenSchema.nullable(),
    // True when the file was already deleted, so nothing changed.
    alreadyApplied: z.boolean(),
  }),
  fileFailureSchema,
]);

const restoreResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    id: z.number().int(),
    filename: z.string(),
    // True when the file wasn't deleted, so nothing changed.
    alreadyApplied: z.boolean(),
  }),
  fileFailureSchema,
]);

// A file that went along with the one asked for.
const deletedLinkedSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  // video, preview_image, output (made from a raw file), or sidecar (the
  // run.json saved with its capture).
  relation: linkedFileRelationSchema,
  deletedAt: isoDateTime,
});

const restoredLinkedSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    id: z.number().int(),
    filename: z.string(),
    relation: linkedFileRelationSchema,
    alreadyApplied: z.boolean(),
  }),
  fileFailureSchema.extend({ relation: linkedFileRelationSchema }),
]);

const count = z.number().int();

export const deleteFilesOutputSchema = z.object({
  instrumentId: z.string(),
  runId: z.string(),
  // One result per file, in the order given, repeated IDs dropped.
  results: z.array(deleteResultSchema),
  // The files deleted along with the requested ones, when includeLinked is
  // true.
  linked: z.array(deletedLinkedSchema),
  counts: z.object({
    deleted: count,
    alreadyDeleted: count,
    failed: count,
  }),
});

export const restoreFilesOutputSchema = z.object({
  instrumentId: z.string(),
  runId: z.string(),
  results: z.array(restoreResultSchema),
  // The deleted files restored along with the requested ones, when
  // includeLinked is true, and the ones that couldn't be.
  linked: z.array(restoredLinkedSchema),
  counts: z.object({
    restored: count,
    alreadyRestored: count,
    failed: count,
  }),
});
