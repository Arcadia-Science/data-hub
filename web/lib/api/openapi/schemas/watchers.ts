import { z } from "zod";
import {
  isoDateTime,
  uploadModeSchema,
  watcherEventTypeSchema,
  watcherStatusSchema,
} from "./common";

export const registerWatcherBody = z.object({
  instrument_id: z.string().min(1),
  hostname: z.string().optional(),
  os_info: z.string().optional(),
});

export const watcherConfigBody = z.object({
  config_checksum: z.string().min(1),
  config_yaml: z.string().min(1),
});

const watcherEventItem = z.object({
  event_type: watcherEventTypeSchema,
  timestamp: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const watcherEventBody = z.object({
  events: z.array(watcherEventItem).min(1).max(100),
});

export const heartbeatBody = z.object({
  status: z.enum(["registered", "watching", "stopped"]),
  timestamp: z.string().optional(),
  watcher_version: z.string().optional(),
  upload_mode: uploadModeSchema.optional(),
  files_uploaded_since_last_heartbeat: z
    .number()
    .int()
    .nonnegative()
    .optional(),
  runs_reported_since_last_heartbeat: z.number().int().nonnegative().optional(),
  errors_since_last_heartbeat: z.number().int().nonnegative().optional(),
  uptime_seconds: z.number().int().nonnegative().optional(),
});

export const watcherDetail = z.object({
  id: z.string().uuid(),
  instrument_id: z.string(),
  instrument_display_name: z.string().nullable().optional(),
  hostname: z.string().nullable(),
  os_info: z.string().nullable(),
  status: watcherStatusSchema,
  config_yaml: z.string().nullable().optional(),
  config_checksum: z.string().nullable().optional(),
  last_heartbeat_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  deleted_at: isoDateTime.nullable(),
});
