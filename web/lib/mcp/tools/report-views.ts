import type { McpServer } from "@modelcontextprotocol/server";
import {
  findActiveFileBySuffix,
  getActiveFileById,
  getActiveFilesByIds,
} from "@/lib/api/files";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { getReportItemsPage } from "@/lib/api/report-items";
import { toAbsoluteDownloadUrl } from "@/lib/mcp/absolute-url";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  getMcpUserId,
  structuredResult,
} from "@/lib/mcp/tools/helpers";
import { REPORT_ITEMS_WINDOW } from "@/lib/runs/report-items";
import { embedDownloadOptions, getPresignedDownloadUrl } from "@/lib/s3";
import {
  reportViewFileUrlTool,
  reportViewItemsTool,
} from "./report-views.defs";

function requireMcpUser(authInfo: Parameters<typeof getMcpUserId>[0]) {
  const userId = getMcpUserId(authInfo);
  if (!userId) {
    return {
      ok: false as const,
      error: errorResult("Authenticated user not available on this session."),
    };
  }
  return { ok: true as const, userId };
}

export function registerReportViewTools(server: McpServer) {
  server.registerTool(
    reportViewItemsTool.name,
    toolRegistrationConfig(reportViewItemsTool),
    async (args, ctx) => {
      const auth = requireMcpUser(ctx.http?.authInfo);
      if (!auth.ok) {
        return auth.error;
      }

      const run = await lookupRunByNaturalKey(args.instrumentId, args.runId);
      if (!run) {
        return errorResult(
          `Run '${args.runId}' not found for instrument '${args.instrumentId}'.`
        );
      }

      const page = await getReportItemsPage(run.id, {
        kind: args.kind,
        offset: args.offset ?? 0,
        limit: args.limit ?? REPORT_ITEMS_WINDOW,
        search: args.search,
        anchorId: args.anchor,
      });

      const stored = await getActiveFilesByIds(
        page.data.map((item) => item.id)
      );
      const byId = new Map(stored.map((file) => [file.id, file]));

      const data = await Promise.all(
        page.data.map(async (item) => {
          const file = byId.get(item.id);
          if (!(file?.s3Bucket && file.s3Key)) {
            return { ...item, downloadUrl: "" };
          }
          const url = await getPresignedDownloadUrl(
            file.s3Bucket,
            file.s3Key,
            embedDownloadOptions(file.filename, file.contentType)
          );
          return { ...item, downloadUrl: toAbsoluteDownloadUrl(url) };
        })
      );

      return structuredResult({ data, pagination: page.pagination });
    }
  );

  server.registerTool(
    reportViewFileUrlTool.name,
    toolRegistrationConfig(reportViewFileUrlTool),
    async (args, ctx) => {
      const auth = requireMcpUser(ctx.http?.authInfo);
      if (!auth.ok) {
        return auth.error;
      }

      if (args.fileId === undefined && !args.suffix) {
        return errorResult("Pass either `fileId` or `suffix`.");
      }

      const run = await lookupRunByNaturalKey(args.instrumentId, args.runId);
      if (!run) {
        return errorResult(
          `Run '${args.runId}' not found for instrument '${args.instrumentId}'.`
        );
      }

      const file =
        args.fileId === undefined
          ? await findActiveFileBySuffix(run.id, args.suffix ?? "")
          : await getActiveFileById(args.fileId);

      // The id lookup is not run-scoped, so check before signing anything.
      if (!file || file.instrumentRunId !== run.id) {
        return errorResult(
          args.fileId === undefined
            ? `No file ending with '${args.suffix}' on run '${args.runId}'.`
            : `File '${args.fileId}' not found on run '${args.runId}'.`
        );
      }

      if (!(file.s3Bucket && file.s3Key)) {
        return errorResult(
          `File '${file.filename}' has not been uploaded yet.`
        );
      }

      const url = await getPresignedDownloadUrl(
        file.s3Bucket,
        file.s3Key,
        embedDownloadOptions(file.filename, file.contentType)
      );
      return structuredResult({
        id: file.id,
        filename: file.filename,
        url: toAbsoluteDownloadUrl(url),
      });
    }
  );
}
