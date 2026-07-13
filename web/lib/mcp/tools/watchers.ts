import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type EffectiveStatus,
  getWatcherById,
  getWatcherEvents,
  getWatcherHeartbeats,
  getWatcherList,
} from "@/lib/api/watchers";
import { watcherEventTypeEnum } from "@/lib/db/schema";
import {
  errorResult,
  requireMcpScope,
  textResult,
} from "@/lib/mcp/tools/helpers";

export function registerWatcherTools(server: McpServer) {
  server.registerTool(
    "list_watchers",
    {
      title: "List Watchers",
      description:
        "List watcher agents with effective status, hostname, instrument assignment, and last heartbeat. Optionally include deregistered watchers or filter by effective status.",
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
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId, includeDeleted, status }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "watchers:read");
      if (scopeError) {
        return scopeError;
      }
      let watchers = await getWatcherList({
        includeDeleted: includeDeleted ?? false,
      });
      if (instrumentId) {
        watchers = watchers.filter((w) => w.instrumentId === instrumentId);
      }
      if (status) {
        watchers = watchers.filter(
          (w) => w.effectiveStatus === (status as EffectiveStatus)
        );
      }
      return textResult(watchers);
    }
  );

  server.registerTool(
    "get_watcher",
    {
      title: "Get Watcher",
      description:
        "Get watcher detail including config YAML, OS info, effective status, and deregistration actor when applicable.",
      inputSchema: {
        watcherId: z.string().describe("Watcher UUID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ watcherId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "watchers:read");
      if (scopeError) {
        return scopeError;
      }
      const watcher = await getWatcherById(watcherId);
      if (!watcher) {
        return errorResult(`Watcher '${watcherId}' not found.`);
      }
      return textResult(watcher);
    }
  );

  server.registerTool(
    "list_watcher_events",
    {
      title: "List Watcher Events",
      description:
        "Paginated watcher event log (uploads, errors, config sync, update lifecycle). Useful after get_watcher_heartbeats when diagnosing failures.",
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
      annotations: { readOnlyHint: true },
    },
    async ({ watcherId, hours, eventTypes, page, pageSize }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "watchers:read");
      if (scopeError) {
        return scopeError;
      }
      const lookbackHours = hours ?? 24;
      const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
      const result = await getWatcherEvents(watcherId, {
        since,
        eventTypes,
        page: page ?? 1,
        pageSize: pageSize ?? 50,
      });
      return textResult({
        watcherId,
        sinceIso: since.toISOString(),
        lookbackHours,
        ...result,
      });
    }
  );

  server.registerTool(
    "get_watcher_heartbeats",
    {
      title: "Get Watcher Heartbeats",
      description:
        "Get recent heartbeat history for a watcher agent, useful for diagnosing connectivity gaps and error trends. Returns up to 100 most recent heartbeats within the lookback window.",
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
      annotations: { readOnlyHint: true },
    },
    async ({ watcherId, hours }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "watchers:read");
      if (scopeError) {
        return scopeError;
      }
      const lookbackHours = hours ?? 24;
      const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
      const { rows, total } = await getWatcherHeartbeats(watcherId, {
        since,
        page: 1,
        pageSize: 100,
      });
      return textResult({
        watcherId,
        sinceIso: since.toISOString(),
        lookbackHours,
        total,
        heartbeats: rows,
      });
    }
  );
}
