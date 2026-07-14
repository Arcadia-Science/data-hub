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

// Shared by the detail (`GET /watchers/{id}`) and list responses. Detail
// includes `config_*` and omits `deleted_at`; the list is the reverse — so
// the fields that differ are optional.
export const watcherDetail = z
  .object({
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
    deleted_at: isoDateTime.nullable().optional(),
  })
  .openapi("WatcherDetail");

export const watcherListResponse = z.object({
  data: z.array(watcherDetail),
});

export const watcherRegistered = z.object({
  watcher_id: z.string().uuid(),
});

export const watcherDeleted = z.object({
  id: z.string().uuid(),
  deleted_at: isoDateTime,
});

// Both `PUT /config` and `GET /config-checksum` return only the checksum.
export const watcherChecksumResponse = z.object({
  config_checksum: z.string(),
});

export const watcherEventCreated = z.object({
  received: z.number().int(),
});

const watcherEvent = z.object({
  id: z.number().int(),
  event_type: watcherEventTypeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).nullable(),
  timestamp: isoDateTime,
  created_at: isoDateTime,
});

export const watcherEventsListResponse = z.object({
  data: z.array(watcherEvent),
});

export const watcherHeartbeatAck = z.object({
  ok: z.literal(true),
});

const watcherHeartbeat = z.object({
  id: z.number().int(),
  timestamp: isoDateTime,
  status: z.string(),
  upload_mode: uploadModeSchema.nullable(),
  files_uploaded_since_last: z.number().int().nullable(),
  runs_reported_since_last: z.number().int().nullable(),
  errors_since_last: z.number().int().nullable(),
  uptime_seconds: z.number().int().nullable(),
  created_at: isoDateTime,
});

export const watcherHeartbeatsListResponse = z.object({
  data: z.array(watcherHeartbeat),
});

export const watcherUploadQueueResponse = z.object({
  files: z.array(
    z.object({
      id: z.number().int(),
      instrument_id: z.string(),
      run_id: z.string(),
      relative_path: z.string(),
      filename: z.string(),
      size_bytes: z.number().nullable(),
    })
  ),
});

export const watcherUpdateCheckResponse = z.object({
  channel: z.string(),
  latest_version: z.string().nullable(),
  mandatory: z.boolean(),
  min_supported_version: z.string().nullable(),
});
