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
  watcherConfigBody,
  watcherEventBody,
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
    responses: responses(`${summary}.`),
  });

operation(
  "get",
  "/watchers",
  "listWatchers",
  "List watchers",
  "watchers:read",
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
    201: jsonResponse(
      "Registered watcher.",
      z.object({ watcher_id: z.string().uuid() })
    ),
    ...errorResponses(),
  },
});
operation(
  "get",
  "/watchers/{watcherId}",
  "getWatcher",
  "Get a watcher",
  "watchers:read",
  { params: watcherParams }
);
operation(
  "delete",
  "/watchers/{watcherId}",
  "deleteWatcher",
  "Deregister a watcher",
  "watchers:admin",
  { params: watcherParams }
);
operation(
  "put",
  "/watchers/{watcherId}/config",
  "updateWatcherConfig",
  "Update watcher configuration",
  "watchers:report",
  { params: watcherParams, body: body(watcherConfigBody) }
);
operation(
  "get",
  "/watchers/{watcherId}/config-checksum",
  "getWatcherConfigChecksum",
  "Get watcher configuration checksum",
  "watchers:read",
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
    201: jsonResponse("Created event.", z.unknown()),
    ...errorResponses(),
  },
});
operation(
  "get",
  "/watchers/{watcherId}/events",
  "listWatcherEvents",
  "List watcher events",
  "watchers:read",
  { params: watcherParams }
);
operation(
  "post",
  "/watchers/{watcherId}/heartbeat",
  "recordWatcherHeartbeat",
  "Record a watcher heartbeat",
  "watchers:report",
  { params: watcherParams, body: body(heartbeatBody) }
);
operation(
  "get",
  "/watchers/{watcherId}/heartbeats",
  "listWatcherHeartbeats",
  "List watcher heartbeats",
  "watchers:read",
  { params: watcherParams }
);
operation(
  "get",
  "/watchers/{watcherId}/upload-queue",
  "getWatcherUploadQueue",
  "Get watcher upload queue",
  "watchers:read",
  { params: watcherParams }
);
operation(
  "get",
  "/watchers/{watcherId}/update-check",
  "checkWatcherUpdate",
  "Check watcher update availability",
  "watchers:read",
  { params: watcherParams }
);
