import { z } from "zod";
import {
  FILE_PATTERN_MAX_LENGTH,
  FILE_PATTERNS_MAX,
  MAX_STABILITY_WAIT_RANGE,
  STABILITY_PERIOD_RANGE,
  UPLOAD_PARALLELISM_RANGE,
  WATCH_DIRECTORY_MAX_LENGTH,
} from "@/lib/api/watcher-config/settings";
import { watcherEventTypeEnum } from "@/lib/db/schema";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import {
  getWatcherHeartbeatsOutputSchema,
  getWatcherOutputSchema,
  listWatcherEventsOutputSchema,
  listWatchersOutputSchema,
  updateWatcherConfigOutputSchema,
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
      .enum(["registered", "watching", "stopped", "waiting", "stale"])
      .optional()
      .describe(
        "Filter by effective status. stale is computed, never stored: a watching or waiting watcher with no heartbeat for 5 minutes, or one that stopped for a restart or an update and has sent none for 15 minutes. A stopped watcher otherwise stays stopped."
      ),
  },
  outputSchema: listWatchersOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getWatcherTool = {
  name: "get_watcher",
  title: "Get Watcher",
  description:
    "Get watcher detail including config YAML, OS info, effective status (with statusReason when waiting for a missing folder, or when stopped for a Windows restart or an update: system_shutdown or auto_update), config revision numbers, any pending config change, and deregistration actor when applicable. appliedConfigRevision is the revision the watcher reports running. configYaml is its config file, which can be newer: when pcEditAwaitingRestart is true, the file was edited on the PC while the watcher ran, and that edit takes effect when the watcher restarts.",
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

export const updateWatcherConfigTool = {
  name: "update_watcher_config",
  title: "Update Watcher Config",
  description:
    "Change a watcher's settings from Data Hub. Admins only. Before calling, call get_watcher, show the user exactly which settings will change (old and new values), and get their confirmation. Pass baseRevision as get_watcher's configRevision. Settings you leave out keep their current values: the pending change if there is one, otherwise the settings the watcher last applied. A rejected change isn't carried over; to retry it, pass its settings again. The change is stored as pending and the watcher applies it within about a minute of its next heartbeat; if the watcher can't (for example the folder doesn't exist), it rejects the change and keeps its old settings. Needs watcher 1.4.0 or later. watch_directory can point at any folder on the instrument PC.",
  group: "watchers",
  scope: "watchers:admin",
  inputSchema: {
    watcherId: z.string().describe("Watcher UUID"),
    baseRevision: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe(
        "The latest revision number from get_watcher (configRevision), or null if it has none. A stale value is refused."
      ),
    settings: z
      .object({
        watch_directory: z
          .string()
          .min(1)
          .max(WATCH_DIRECTORY_MAX_LENGTH)
          .optional()
          .describe(
            "Absolute folder on the instrument PC, such as D:\\Exports"
          ),
        file_patterns: z
          .array(z.string().min(1).max(FILE_PATTERN_MAX_LENGTH))
          .min(1)
          .max(FILE_PATTERNS_MAX)
          .optional()
          .describe(
            "Case-sensitive filename globs, such as *.csv. Replaces the whole list."
          ),
        run_detection: z
          .object({
            pattern: z
              .string()
              .optional()
              .describe(
                "Regex with exactly one capture group, matched against the forward-slash path relative to the folder. Group 1 is the run ID."
              ),
            recursive: z.boolean().optional().describe("Watch subfolders too"),
          })
          .optional(),
        upload_mode: z
          .enum(["auto", "manual"])
          .optional()
          .describe(
            "auto uploads new files; manual only reports them until someone requests an upload"
          ),
        stability_period_seconds: z
          .number()
          .int()
          .min(STABILITY_PERIOD_RANGE.min)
          .max(STABILITY_PERIOD_RANGE.max)
          .optional(),
        max_stability_wait_seconds: z
          .number()
          .int()
          .min(MAX_STABILITY_WAIT_RANGE.min)
          .max(MAX_STABILITY_WAIT_RANGE.max)
          .optional(),
        upload_parallelism: z
          .number()
          .int()
          .min(UPLOAD_PARALLELISM_RANGE.min)
          .max(UPLOAD_PARALLELISM_RANGE.max)
          .optional(),
      })
      .describe("Only the settings to change"),
  },
  outputSchema: updateWatcherConfigOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false },
} as const satisfies McpToolDef;

export const WATCHER_TOOL_DEFS = [
  listWatchersTool,
  getWatcherTool,
  listWatcherEventsTool,
  getWatcherHeartbeatsTool,
  updateWatcherConfigTool,
] as const;
