import type { McpServer } from "@modelcontextprotocol/server";
import {
  type EffectiveStatus,
  getWatcherById,
  getWatcherEvents,
  getWatcherHeartbeats,
  getWatcherList,
} from "@/lib/api/watchers";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import { errorResult, structuredResult } from "@/lib/mcp/tools/helpers";
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
    async ({ instrumentId, includeDeleted, status }) => {
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
      return structuredResult({ watchers });
    }
  );

  server.registerTool(
    getWatcherTool.name,
    toolRegistrationConfig(getWatcherTool),
    async ({ watcherId }) => {
      const watcher = await getWatcherById(watcherId);
      if (!watcher) {
        return errorResult(`Watcher '${watcherId}' not found.`);
      }
      return structuredResult(watcher);
    }
  );

  server.registerTool(
    listWatcherEventsTool.name,
    toolRegistrationConfig(listWatcherEventsTool),
    async ({ watcherId, hours, eventTypes, page, pageSize }) => {
      const lookbackHours = hours ?? 24;
      const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
      const { rows, total } = await getWatcherEvents(watcherId, {
        since,
        eventTypes,
        page: page ?? 1,
        pageSize: pageSize ?? 50,
      });
      return structuredResult({
        watcherId,
        sinceIso: since.toISOString(),
        lookbackHours,
        rows,
        total,
      });
    }
  );

  server.registerTool(
    getWatcherHeartbeatsTool.name,
    toolRegistrationConfig(getWatcherHeartbeatsTool),
    async ({ watcherId, hours }) => {
      const lookbackHours = hours ?? 24;
      const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
      const { rows, total } = await getWatcherHeartbeats(watcherId, {
        since,
        page: 1,
        pageSize: 100,
      });
      return structuredResult({
        watcherId,
        sinceIso: since.toISOString(),
        lookbackHours,
        total,
        heartbeats: rows,
      });
    }
  );
}
