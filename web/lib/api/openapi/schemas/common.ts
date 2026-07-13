import { z } from "zod";
import {
  archiveJobStatusEnum,
  fileCategoryEnum,
  fileStatusEnum,
  VALID_INSTRUMENT_TYPES,
  watcherEventTypeEnum,
} from "@/lib/db/schema";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status";

export const isoDateTime = z.string().datetime({ offset: true });
export const instrumentTypeSchema = z.enum(VALID_INSTRUMENT_TYPES);
export const instrumentStatusSchema = z.enum(["pending", "active", "inactive"]);
export const runStatusSchema = z.enum(RUN_STATUS_VALUES);
export const runSourceSchema = z.enum(["lambda", "watcher"]);
export const fileCategorySchema = z.enum(fileCategoryEnum.enumValues);
export const fileStatusSchema = z.enum(fileStatusEnum.enumValues);
export const watcherStatusSchema = z.enum([
  "registered",
  "watching",
  "stopped",
  "stale",
]);
export const watcherEventTypeSchema = z.enum(watcherEventTypeEnum.enumValues);
export const uploadModeSchema = z.enum(["auto", "manual"]);
export const archiveJobStatusSchema = z.enum(archiveJobStatusEnum.enumValues);
export const paginationSchema = z.object({
  page: z.number().int(),
  per_page: z.number().int(),
  total: z.number().int(),
  total_pages: z.number().int(),
});
