import { z } from "zod";
import {
  bearerSecurity,
  errorResponses,
  jsonResponse,
  registry,
  watcherIdParam,
} from "../registry";
import {
  createWatcherConfigRevisionBody,
  heartbeatBody,
  registerWatcherBody,
  watcherChecksumResponse,
  watcherConfigBody,
  watcherConfigPushResponse,
  watcherConfigRevision,
  watcherConfigRevisionResultBody,
  watcherConfigRevisionsListResponse,
  watcherDeleted,
  watcherDetail,
  watcherEventBody,
  watcherEventCreated,
  watcherEventsListResponse,
  watcherHeartbeatAck,
  watcherHeartbeatsListResponse,
  watcherListResponse,
  watcherRegistered,
  watcherUpdateCheckResponse,
  watcherUploadQueueResponse,
} from "../schemas/watchers";

const watcherParams = z.object({ watcherId: watcherIdParam });
const body = (schema: z.ZodType) => ({
  content: { "application/json": { schema } },
});
const responses = (description: string, schema: z.ZodType = z.unknown()) => ({
  200: jsonResponse(description, schema),
  ...errorResponses(),
});
const PAT_ONLY = " PAT only; browser sessions are rejected.";

const operation = (
  method: "get" | "post" | "put" | "delete",
  path: string,
  operationId: string,
  summary: string,
  scope: string,
  responseSchema: z.ZodType,
  request?: object,
  patOnly = false
) =>
  registry.registerPath({
    method,
    path,
    operationId,
    summary,
    description: `Requires scope \`${scope}\`.${patOnly ? PAT_ONLY : ""}`,
    tags: ["Watchers"],
    security: bearerSecurity,
    ...(request ? { request } : {}),
    responses: responses(`${summary}.`, responseSchema),
  });

operation(
  "get",
  "/watchers",
  "listWatchers",
  "List watchers",
  "watchers:read",
  watcherListResponse,
  {
    query: z.object({
      instrument_id: z.string().optional(),
      status: z
        .enum(["registered", "watching", "stopped", "waiting", "stale"])
        .optional(),
      include_deleted: z.coerce.boolean().optional(),
    }),
  }
);
registry.registerPath({
  method: "post",
  path: "/watchers/register",
  operationId: "registerWatcher",
  summary: "Register a watcher",
  description:
    "Requires scope `watchers:report`. PAT only; browser sessions are rejected.",
  tags: ["Watchers"],
  security: bearerSecurity,
  request: { body: body(registerWatcherBody) },
  responses: {
    201: jsonResponse("Registered watcher.", watcherRegistered),
    ...errorResponses(),
  },
});
operation(
  "get",
  "/watchers/{watcherId}",
  "getWatcher",
  "Get a watcher",
  "watchers:read",
  watcherDetail,
  { params: watcherParams }
);
operation(
  "delete",
  "/watchers/{watcherId}",
  "deleteWatcher",
  "Deregister a watcher",
  "watchers:admin",
  watcherDeleted,
  { params: watcherParams }
);
operation(
  "put",
  "/watchers/{watcherId}/config",
  "updateWatcherConfig",
  "Update watcher configuration",
  "watchers:report",
  watcherConfigPushResponse,
  { params: watcherParams, body: body(watcherConfigBody) },
  true
);
operation(
  "get",
  "/watchers/{watcherId}/config-checksum",
  "getWatcherConfigChecksum",
  "Get watcher configuration checksum",
  "watchers:read",
  watcherChecksumResponse,
  { params: watcherParams },
  true
);
registry.registerPath({
  method: "post",
  path: "/watchers/{watcherId}/events",
  operationId: "createWatcherEvent",
  summary: "Report a watcher event",
  description:
    "Requires scope `watchers:report`. PAT only; browser sessions are rejected.",
  tags: ["Watchers"],
  security: bearerSecurity,
  request: { params: watcherParams, body: body(watcherEventBody) },
  responses: {
    201: jsonResponse("Created event.", watcherEventCreated),
    ...errorResponses(),
  },
});
operation(
  "get",
  "/watchers/{watcherId}/events",
  "listWatcherEvents",
  "List watcher events",
  "watchers:read",
  watcherEventsListResponse,
  { params: watcherParams }
);
operation(
  "post",
  "/watchers/{watcherId}/heartbeat",
  "recordWatcherHeartbeat",
  "Record a watcher heartbeat",
  "watchers:report",
  watcherHeartbeatAck,
  { params: watcherParams, body: body(heartbeatBody) },
  true
);
operation(
  "get",
  "/watchers/{watcherId}/heartbeats",
  "listWatcherHeartbeats",
  "List watcher heartbeats",
  "watchers:read",
  watcherHeartbeatsListResponse,
  { params: watcherParams }
);
operation(
  "get",
  "/watchers/{watcherId}/upload-queue",
  "getWatcherUploadQueue",
  "Get watcher upload queue",
  "watchers:read",
  watcherUploadQueueResponse,
  { params: watcherParams },
  true
);
operation(
  "get",
  "/watchers/{watcherId}/update-check",
  "checkWatcherUpdate",
  "Check watcher update availability",
  "watchers:read",
  watcherUpdateCheckResponse,
  { params: watcherParams },
  true
);

const revisionParams = z.object({
  watcherId: watcherIdParam,
  revision: z.number().int().positive(),
});

operation(
  "get",
  "/watchers/{watcherId}/config-revisions",
  "listWatcherConfigRevisions",
  "List watcher config revisions",
  "watchers:read",
  watcherConfigRevisionsListResponse,
  {
    params: watcherParams,
    query: z.object({
      limit: z.number().int().min(1).max(200).optional(),
    }),
  }
);
registry.registerPath({
  method: "post",
  path: "/watchers/{watcherId}/config-revisions",
  operationId: "createWatcherConfigRevision",
  summary: "Change a watcher's config",
  description:
    "Requires scope `watchers:admin`. Browser sessions must belong to an admin. Stores a pending revision that the watcher applies after its next heartbeat. Returns 409 when `base_revision` isn't the latest revision (`details.reason: stale_revision`) or the watcher runs a version older than 1.3.0 (`details.reason: watcher_update_required`).",
  tags: ["Watchers"],
  security: bearerSecurity,
  request: {
    params: watcherParams,
    body: body(createWatcherConfigRevisionBody),
  },
  responses: {
    201: jsonResponse("Created revision.", watcherConfigRevision),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "get",
  path: "/watchers/{watcherId}/config-revisions/latest",
  operationId: "getLatestWatcherConfigRevision",
  summary: "Get the config revision a watcher should apply",
  description:
    "Requires scope `watchers:read`. PAT only; browser sessions are rejected. Returns the newest `pending` revision if there is one, otherwise the highest-numbered revision. A pending revision can sit below a higher `superseded` one when a change from Data Hub wins over an older offline edit on the PC. Returns 404 when the watcher has no revisions.",
  tags: ["Watchers"],
  security: bearerSecurity,
  request: { params: watcherParams },
  responses: {
    200: jsonResponse("The revision to apply.", watcherConfigRevision),
    ...errorResponses(),
  },
});
operation(
  "post",
  "/watchers/{watcherId}/config-revisions/{revision}/result",
  "reportWatcherConfigRevisionResult",
  "Report whether a config revision was applied",
  "watchers:report",
  watcherConfigRevision,
  { params: revisionParams, body: body(watcherConfigRevisionResultBody) },
  true
);
