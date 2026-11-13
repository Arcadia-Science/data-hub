import { z } from "zod";
import { watcherConfigSettingsSchema } from "@/lib/api/watcher-config/settings";
import {
  isoDateTime,
  uploadModeSchema,
  watcherEventInputTypeSchema,
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
  // The highest config revision the watcher had applied when it read the
  // file. Sent by watcher 1.4.0 and later.
  based_on_revision: z.number().int().nonnegative().nullable().optional(),
  // The local file's modification time, used to settle a conflict between
  // an offline edit on the PC and a change waiting in Data Hub.
  modified_at: isoDateTime.optional(),
});

const watcherEventItem = z.object({
  // Types that only Data Hub writes, such as `upload_requests_cancelled`, are
  // not accepted here.
  event_type: watcherEventInputTypeSchema,
  timestamp: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const watcherEventBody = z.object({
  events: z.array(watcherEventItem).min(1).max(100),
});

export const heartbeatBody = z.object({
  status: z.enum(["registered", "watching", "stopped", "waiting"]),
  // Why the watcher is `waiting`, for example a missing watch folder. On a
  // `stopped` heartbeat, `system_shutdown` says Windows is shutting down or
  // restarting (watcher 1.4.1 and later send it), and `auto_update` says the
  // watcher is stopping to install an automatic update (watcher 1.4.2 and
  // later send it). The route stores a reason for `waiting` and for those two
  // stops only.
  status_reason: z.string().max(500).optional().openapi({
    description:
      "Why the watcher is `waiting`, for example a missing watch folder. On a `stopped` heartbeat, `system_shutdown` says the watcher stopped because Windows is shutting down or restarting (watcher 1.4.1 and later send it), and `auto_update` says it stopped to install an automatic update and start again (watcher 1.4.2 and later send it). Data Hub keeps these two reasons on the watcher, keeps the instrument's requested uploads queued for the watcher to upload after it starts again, and cancels them only if no heartbeat arrives for about 15 minutes. After that long without a heartbeat the watcher shows as `stale`. Any other `stopped` heartbeat cancels the requested uploads at once, and its reason is not kept.",
  }),
  // The highest config revision this watcher has applied.
  config_revision: z.number().int().nonnegative().nullable().optional(),
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
    // `.describe` rather than `.openapi`. `watcherStatusSchema` is built in
    // `./common`, which the MCP tool outputs also import directly. A schema
    // built before `registry.ts` calls `extendZodWithOpenApi` has no
    // `.openapi`, and whether `./common` loads before the registry depends on
    // which route the server loads first, so `.openapi` here can break
    // `next build`. `.describe` doesn't need the extension.
    status: watcherStatusSchema.describe(
      "The status Data Hub shows for the watcher. `stale` is worked out when you ask and is never stored. A `watching` or `waiting` watcher is `stale` when its last heartbeat is more than 5 minutes old. A `stopped` watcher stays `stopped`, however old its last heartbeat, unless it stopped for a restart or an update (see `status_reason`): then it is `stale` when its last heartbeat is more than 15 minutes old. A deregistered watcher is always `stopped`. The `status` filter on the list endpoint returns the watchers that show that status."
    ),
    config_yaml: z.string().nullable().optional(),
    config_checksum: z.string().nullable().optional(),
    config_revision: z.number().int().nullable().optional(),
    applied_config_revision: z.number().int().nullable().optional(),
    status_reason: z.string().nullable().optional().openapi({
      description:
        "Why the watcher is `waiting` (for example a missing watch folder), or why it stopped for a restart: `system_shutdown` for Windows shutting down or restarting, `auto_update` for an automatic update (watcher 1.4.2 and later send it). It is the reason of the watcher's last heartbeat, so it stays while `status` reads `stale`. It is null when that heartbeat was any other status, or a stop that gave no such reason.",
    }),
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

export const watcherChecksumResponse = z.object({
  config_checksum: z.string(),
});

export const watcherConfigPushResponse = z.object({
  config_checksum: z.string(),
  // The highest config revision after this push, or null when there are none.
  config_revision: z.number().int().nullable(),
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
  // The latest config revision for this watcher, or null when there are none.
  // A watcher that has seen a lower number fetches the latest revision.
  config_revision: z.number().int().nullable(),
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
  latest_version: z.string().nullable(),
  mandatory: z.boolean(),
  min_supported_version: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Config revisions
// ---------------------------------------------------------------------------

// The watcher settings that can be edited from Data Hub. Key names match the
// YAML keys under `instrument:` in the watcher's config file. Used as is,
// without `.openapi()`: the schema lives outside this module, and the
// production server bundle can load it with a Zod copy the registry never
// extended.
export const watcherConfigSettings = watcherConfigSettingsSchema;

export const watcherConfigRevision = z
  .object({
    revision: z.number().int().positive(),
    source: z.enum(["web", "pc"]),
    status: z.enum(["pending", "applied", "rejected", "superseded"]),
    status_reason: z.string().nullable(),
    settings: watcherConfigSettings,
    created_at: isoDateTime,
    resolved_at: isoDateTime.nullable(),
    created_by: z
      .object({ id: z.string(), name: z.string(), email: z.string() })
      .nullable(),
    created_by_token: z.object({ id: z.string(), name: z.string() }).nullable(),
  })
  .openapi("WatcherConfigRevision");

export const watcherConfigRevisionsListResponse = z.object({
  data: z.array(watcherConfigRevision),
});

export const createWatcherConfigRevisionBody = z.object({
  // The latest revision number the change was based on, or null when the
  // watcher has none. A stale value gets 409.
  base_revision: z.number().int().positive().nullable(),
  settings: watcherConfigSettings,
});

export const watcherConfigRevisionResultBody = z.object({
  status: z.enum(["applied", "rejected"]),
  reason: z.string().max(1000).optional(),
});

// UI-only (not registered as a path), so plain schemas are enough.
export const watcherConfigPreviewBody = z.object({
  settings: watcherConfigSettingsSchema,
});

export const watcherConfigPreviewResponse = z.object({
  sample_size: z.number().int(),
  files: z.array(
    z.object({
      relative_path: z.string(),
      matches: z.boolean(),
      run_id: z.string().nullable(),
    })
  ),
});
