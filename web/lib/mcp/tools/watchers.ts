import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type EffectiveStatus,
  getWatcherById,
  getWatcherEvents,
  getWatcherHeartbeats,
  getWatcherList,
} from "@/lib/api/watchers";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  requireMcpScope,
  textResult,
} from "@/lib/mcp/tools/helpers";
import {
  getWatcherHeartbeatsTool,
  getWatcherTool,
  listWatcherEventsTool,
  listWatchersTool,
} from "./watchers.defs";

export function registerWatcherTools(server: McpServer) {
  server.registerTool(
    listWatchersTool.name,
    toolRegistrationConfig(listWatchersTool),
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
    getWatcherTool.name,
    toolRegistrationConfig(getWatcherTool),
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
    listWatcherEventsTool.name,
    toolRegistrationConfig(listWatcherEventsTool),
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
    getWatcherHeartbeatsTool.name,
    toolRegistrationConfig(getWatcherHeartbeatsTool),
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
