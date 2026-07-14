import { z } from "zod";
import {
  bearerSecurity,
  errorResponses,
  jsonResponse,
  registry,
  watcherIdParam,
} from "../registry";
import {
  heartbeatBody,
  registerWatcherBody,
  watcherChecksumResponse,
  watcherConfigBody,
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
const operation = (
  method: "get" | "post" | "put" | "delete",
  path: string,
  operationId: string,
  summary: string,
  scope: string,
  responseSchema: z.ZodType,
  request?: object
) =>
  registry.registerPath({
    method,
    path,
    operationId,
    summary,
    description: `Requires scope \`${scope}\`.`,
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
      status: z.enum(["registered", "watching", "stopped", "stale"]).optional(),
      include_deleted: z.coerce.boolean().optional(),
    }),
  }
);
registry.registerPath({
  method: "post",
  path: "/watchers/register",
  operationId: "registerWatcher",
  summary: "Register a watcher",
  description: "Requires scope `watchers:report`.",
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
  watcherChecksumResponse,
  { params: watcherParams, body: body(watcherConfigBody) }
);
operation(
  "get",
  "/watchers/{watcherId}/config-checksum",
  "getWatcherConfigChecksum",
  "Get watcher configuration checksum",
  "watchers:read",
  watcherChecksumResponse,
  { params: watcherParams }
);
registry.registerPath({
  method: "post",
  path: "/watchers/{watcherId}/events",
  operationId: "createWatcherEvent",
  summary: "Report a watcher event",
  description: "Requires scope `watchers:report`.",
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
  { params: watcherParams, body: body(heartbeatBody) }
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
  { params: watcherParams }
);
operation(
  "get",
  "/watchers/{watcherId}/update-check",
  "checkWatcherUpdate",
  "Check watcher update availability",
  "watchers:read",
  watcherUpdateCheckResponse,
  { params: watcherParams }
);
