import { z } from "zod";
import type { LinkedFileRelation } from "@/lib/api/file-deletion";
import {
  archiveJobStatusEnum,
  fileCategoryEnum,
  fileStatusEnum,
  uploadFailureReasonEnum,
  VALID_INSTRUMENT_TYPES,
  watcherEventTypeEnum,
} from "@/lib/db/schema";
import {
  DEPRECATED_PENDING_RUN_STATUS,
  RUN_STATUS_VALUES,
} from "@/lib/runs/run-status";

// The MCP tool outputs import this file directly, so it can load before
// `../registry.ts` adds `.openapi()` to Zod. A schema built then never gets
// `.openapi()`, so calling it on an export from here can break every route
// that loads the OpenAPI schemas. Call `.describe()` on these instead, or
// call `.openapi()` on a new schema made from one, such as `.optional()`.
// tests/unit/openapi-load-order.test.ts loads the schemas in this order.

export const isoDateTime = z.string().datetime({ offset: true });
export const instrumentTypeSchema = z.enum(VALID_INSTRUMENT_TYPES);
export const instrumentStatusSchema = z.enum(["pending", "active", "inactive"]);
export const runStatusSchema = z.enum(RUN_STATUS_VALUES);
// A run-status filter value: any run status, or the deprecated `pending`,
// which matches `waiting_upload` and `not_uploaded`.
export const runStatusFilterSchema = z.enum([
  ...RUN_STATUS_VALUES,
  DEPRECATED_PENDING_RUN_STATUS,
]);
export const runSourceSchema = z.enum(["lambda", "watcher"]);
export const fileCategorySchema = z.enum(fileCategoryEnum.enumValues);
export const fileStatusSchema = z.enum(fileStatusEnum.enumValues);
// How a linked file relates to the file it was found from. The values are the
// ones `findLinkedFiles` reports, and the type import keeps the two in step.
export const LINKED_FILE_RELATIONS = [
  "video",
  "preview_image",
  "output",
  "sidecar",
  "made_from",
] as const satisfies readonly LinkedFileRelation[];
export const linkedFileRelationSchema = z.enum(LINKED_FILE_RELATIONS);
export const uploadFailureReasonSchema = z.enum(
  uploadFailureReasonEnum.enumValues
);
export const watcherStatusSchema = z.enum([
  "registered",
  "watching",
  "stopped",
  "waiting",
  "stale",
]);
export const watcherEventTypeSchema = z.enum(watcherEventTypeEnum.enumValues);
// Event types that only Data Hub writes. The events a watcher posts leave
// them out, so a watcher token can't forge them. Reading and filtering events
// still use the full `watcherEventTypeSchema`.
export const SERVER_ONLY_WATCHER_EVENT_TYPES = [
  "upload_requests_cancelled",
  "uploads_failed",
] as const;
export const watcherEventInputTypeSchema = watcherEventTypeSchema.exclude(
  SERVER_ONLY_WATCHER_EVENT_TYPES
);
export const uploadModeSchema = z.enum(["auto", "manual"]);
export const archiveJobStatusSchema = z.enum(archiveJobStatusEnum.enumValues);
export const paginationSchema = z.object({
  page: z.number().int(),
  per_page: z.number().int(),
  total: z.number().int(),
  total_pages: z.number().int(),
});
