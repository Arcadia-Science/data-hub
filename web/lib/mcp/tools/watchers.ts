import type { McpServer } from "@modelcontextprotocol/server";
import { actorToken, actorUser } from "@/lib/api/actor";
import { parseSettingsFromYaml } from "@/lib/api/watcher-config/from-yaml";
import {
  type ConfigRevision,
  createWebConfigRevision,
  getCurrentConfigRevision,
  getPendingConfigRevision,
} from "@/lib/api/watcher-config/revisions";
import {
  type WatcherConfigSettings,
  watcherConfigSettingsSchema,
} from "@/lib/api/watcher-config/settings";
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
  getMcpUserId,
  requireMcpAdmin,
  requireMcpWrite,
  structuredResult,
} from "@/lib/mcp/tools/helpers";
import {
  getWatcherHeartbeatsTool,
  getWatcherTool,
  listWatcherEventsTool,
  listWatchersTool,
  updateWatcherConfigTool,
} from "./watchers.defs";

function toMcpRevision(rev: ConfigRevision) {
  return {
    revision: rev.revision,
    source: rev.source,
    status: rev.status,
    statusReason: rev.statusReason,
    settings: rev.settings,
    createdAt: rev.createdAt,
    resolvedAt: rev.resolvedAt,
    createdByUser: actorUser(rev.createdBy),
    createdByToken: actorToken(rev.createdBy),
  };
}

type SettingsPatch = Partial<
  Omit<WatcherConfigSettings, "run_detection"> & {
    run_detection: Partial<WatcherConfigSettings["run_detection"]>;
  }
>;

// Settings the caller left out keep their current values. `run_detection`
// merges field by field; `file_patterns` replaces the whole list.
function mergeSettings(
  base: WatcherConfigSettings,
  patch: SettingsPatch
): unknown {
  const { run_detection: runDetection, ...rest } = patch;
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined)
    ),
    run_detection: {
      pattern: runDetection?.pattern ?? base.run_detection.pattern,
      recursive: runDetection?.recursive ?? base.run_detection.recursive,
    },
  };
}

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
      const { deregisteredBy, ...fields } = watcher;
      const pending =
        watcher.configRevisionStatus === "pending"
          ? await getPendingConfigRevision(watcherId)
          : null;
      return structuredResult({
        ...fields,
        deregisteredByUser: actorUser(deregisteredBy),
        deregisteredByToken: actorToken(deregisteredBy),
        pendingConfigRevision: pending ? toMcpRevision(pending) : null,
      });
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

  server.registerTool(
    updateWatcherConfigTool.name,
    toolRegistrationConfig(updateWatcherConfigTool),
    async ({ watcherId, baseRevision, settings }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
      }
      const adminError = await requireMcpAdmin(authInfo);
      if (adminError) {
        return adminError;
      }
      // `requireMcpAdmin` already refused a missing user id.
      const userId = getMcpUserId(authInfo) as string;

      const watcher = await getWatcherById(watcherId);
      if (!watcher || watcher.deletedAt) {
        return errorResult(`Watcher '${watcherId}' not found.`);
      }

      const current = await getCurrentConfigRevision(watcherId);
      const base =
        current?.settings ?? parseSettingsFromYaml(watcher.configYaml);
      if (!base) {
        return errorResult(
          "This watcher hasn't reported a readable config yet, so there are no settings to change."
        );
      }

      const parsed = watcherConfigSettingsSchema.safeParse(
        mergeSettings(base, settings)
      );
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        return errorResult(`Invalid settings: ${problems}`);
      }

      const result = await createWebConfigRevision({
        watcherId,
        baseRevision,
        settings: parsed.data,
        actor: { kind: "user", userId },
      });
      if (!result.ok) {
        const detail = result.details
          ? ` (${JSON.stringify(result.details)})`
          : "";
        return errorResult(`${result.message}${detail}`);
      }
      return structuredResult({
        watcherId,
        revision: toMcpRevision(result.revision),
      });
    }
  );
}
