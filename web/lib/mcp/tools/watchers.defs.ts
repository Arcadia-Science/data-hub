import { z } from "zod";
import { watcherEventTypeEnum } from "@/lib/db/schema";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import {
  getWatcherHeartbeatsOutputSchema,
  getWatcherOutputSchema,
  listWatcherEventsOutputSchema,
  listWatchersOutputSchema,
} from "./watchers.output";

export const listWatchersTool = {
  name: "list_watchers",
  title: "List Watchers",
  description:
    "List watcher agents with effective status, hostname, instrument assignment, and last heartbeat. Optionally include deregistered watchers or filter by effective status.",
  group: "watchers",
  scope: "watchers:read",
  inputSchema: {
    instrumentId: z
      .string()
      .optional()
      .describe("Filter watchers to a specific instrument"),
    includeDeleted: z
      .boolean()
      .optional()
      .describe(
        "Include soft-deleted (deregistered) watchers (default: false)"
      ),
    status: z
      .enum(["registered", "watching", "stopped", "stale"])
      .optional()
      .describe(
        "Filter by effective status (stale is computed from heartbeat age)"
      ),
  },
  outputSchema: listWatchersOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getWatcherTool = {
  name: "get_watcher",
  title: "Get Watcher",
  description:
    "Get watcher detail including config YAML, OS info, effective status, and deregistration actor when applicable.",
  group: "watchers",
  scope: "watchers:read",
  inputSchema: { watcherId: z.string().describe("Watcher UUID") },
  outputSchema: getWatcherOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const listWatcherEventsTool = {
  name: "list_watcher_events",
  title: "List Watcher Events",
  description:
    "Paginated watcher event log (uploads, errors, config sync, update lifecycle). Useful after get_watcher_heartbeats when diagnosing failures.",
  group: "watchers",
  scope: "watchers:read",
  inputSchema: {
    watcherId: z.string().describe("Watcher UUID"),
    hours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .optional()
      .describe("Lookback window in hours (default: 24, max: 168)"),
    eventTypes: z
      .array(z.enum(watcherEventTypeEnum.enumValues))
      .optional()
      .describe("Filter to specific event types"),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page number (default: 1)"),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Results per page (default: 50, max: 100)"),
  },
  outputSchema: listWatcherEventsOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getWatcherHeartbeatsTool = {
  name: "get_watcher_heartbeats",
  title: "Get Watcher Heartbeats",
  description:
    "Get recent heartbeat history for a watcher agent, useful for diagnosing connectivity gaps and error trends. Returns up to 100 most recent heartbeats within the lookback window.",
  group: "watchers",
  scope: "watchers:read",
  inputSchema: {
    watcherId: z.string().describe("Watcher UUID"),
    hours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .optional()
      .describe("Lookback window in hours (default: 24, max: 168)"),
  },
  outputSchema: getWatcherHeartbeatsOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const WATCHER_TOOL_DEFS = [
  listWatchersTool,
  getWatcherTool,
  listWatcherEventsTool,
  getWatcherHeartbeatsTool,
] as const;
