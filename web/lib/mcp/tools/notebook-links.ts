import type { McpServer } from "@modelcontextprotocol/server";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import {
  bulkAddResultToWire,
  bulkRemoveResultToWire,
  notebookLinkToWire,
} from "@/lib/api/run-notebook-link-wire";
import {
  bulkAddNotebookLink,
  bulkRemoveNotebookLinks,
  type NotebookLinkError,
  updateNotebookLink,
} from "@/lib/api/run-notebook-links";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  getMcpUserId,
  requireMcpWrite,
  structuredResult,
} from "@/lib/mcp/tools/helpers";
import { blankLabelToNull } from "@/lib/notebook-links/url";
import {
  addNotebookLinkTool,
  removeNotebookLinkTool,
  updateNotebookLinkTool,
} from "./notebook-links.defs";

// Links are written as the signed-in user, taken from the session and never
// from the arguments, the same way claims and comments are.
function linkError(error: NotebookLinkError) {
  const linkId = error.details?.link_id;
  return errorResult(
    typeof linkId === "string"
      ? `${error.message} (link ${linkId}).`
      : `${error.message}.`
  );
}

export function registerNotebookLinkTools(server: McpServer) {
  server.registerTool(
    addNotebookLinkTool.name,
    toolRegistrationConfig(addNotebookLinkTool),
    async ({ instrumentId, runIds, url, label }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
      }
      const userId = getMcpUserId(authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }

      const result = await bulkAddNotebookLink({
        runs: runIds.map((runId) => ({ instrumentId, runId })),
        url,
        label: label == null ? null : blankLabelToNull(label),
        actor: { kind: "user", userId },
      });
      if (!result.ok) {
        return linkError(result);
      }

      const wire = bulkAddResultToWire(result.value);
      return structuredResult({
        instrumentId,
        url: wire.url,
        urlKey: wire.url_key,
        results: wire.results.map((entry) => ({
          runId: entry.run_id,
          outcome: entry.outcome,
          link: entry.link,
        })),
        counts: wire.counts,
      });
    }
  );

  server.registerTool(
    updateNotebookLinkTool.name,
    toolRegistrationConfig(updateNotebookLinkTool),
    async ({ instrumentId, runId, linkId, url, label }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
      }
      const userId = getMcpUserId(authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      if (url === undefined && label === undefined) {
        return errorResult("Pass url, label, or both.");
      }

      const run = await lookupRunByNaturalKey(instrumentId, runId);
      if (!run) {
        return errorResult(
          `Run '${runId}' not found for instrument '${instrumentId}'.`
        );
      }

      let nextLabel: string | null | undefined;
      if (label !== undefined) {
        nextLabel = label === null ? null : blankLabelToNull(label);
      }
      const result = await updateNotebookLink({
        runInternalId: run.id,
        linkId,
        url,
        label: nextLabel,
        actor: { kind: "user", userId },
      });
      if (!result.ok) {
        return linkError(result);
      }
      return structuredResult(notebookLinkToWire(result.value));
    }
  );

  server.registerTool(
    removeNotebookLinkTool.name,
    toolRegistrationConfig(removeNotebookLinkTool),
    async ({ instrumentId, runIds, url }, ctx) => {
      const writeError = requireMcpWrite(ctx.http?.authInfo);
      if (writeError) {
        return writeError;
      }

      const result = await bulkRemoveNotebookLinks({
        runs: runIds.map((runId) => ({ instrumentId, runId })),
        urls: [url],
      });
      if (!result.ok) {
        return linkError(result);
      }

      const wire = bulkRemoveResultToWire(result.value);
      return structuredResult({
        instrumentId,
        urlKey: wire.url_keys[0],
        results: wire.results.map((entry) => ({
          runId: entry.run_id,
          outcome: entry.outcome,
          removed: entry.removed,
        })),
        counts: wire.counts,
      });
    }
  );
}
