import { z } from "zod";
import { archiveJobStatusSchema, isoDateTime } from "./common";

// Lambda callback body. `archive_bucket` / `archive_key` are required when
// status is `ready` (enforced in the route after parse).
export const patchArchiveJobBody = z.object({
  status: archiveJobStatusSchema,
  archive_bucket: z.string().min(1).optional(),
  archive_key: z.string().min(1).optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  error_message: z.string().nullable().optional(),
});

export const archiveJobDetail = z.object({
  id: z.string().uuid(),
  status: archiveJobStatusSchema,
  archive_bucket: z.string().nullable().optional(),
  archive_key: z.string().nullable().optional(),
  size_bytes: z.number().int().nullable().optional(),
  error_message: z.string().nullable().optional(),
  completed_at: isoDateTime.nullable().optional(),
});
