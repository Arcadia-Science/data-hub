import type { McpServer } from "@modelcontextprotocol/server";
import {
  findActiveFileBySuffix,
  getActiveFileById,
  getActiveFilesByIds,
  lookupFileForDownload,
} from "@/lib/api/files";
import {
  getAuntyPlateData,
  getRunReportFiles,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import { getReportItemsPage } from "@/lib/api/report-items";
import { toAbsoluteDownloadUrl } from "@/lib/mcp/absolute-url";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  getMcpUserId,
  structuredResult,
} from "@/lib/mcp/tools/helpers";
import {
  REPORT_VIEW_TABLE_DEFAULT_LIMIT,
  REPORT_VIEW_TABLE_MAX_LIMIT,
  REPORT_VIEW_TABLE_SCAN_CAP,
} from "@/lib/mcp/ui-apps";
import { parseCsvPage } from "@/lib/runs/parse-csv-page";
import { REPORT_ITEMS_WINDOW } from "@/lib/runs/report-items";
import { getPresignedDownloadUrl, getS3ObjectStream } from "@/lib/s3";
import {
  reportViewArtifactTool,
  reportViewItemsTool,
  reportViewTableTool,
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

async function streamToBuffer(
  stream: import("node:stream").Readable
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
          // Omit filename so the URL is not forced to Content-Disposition:
          // attachment — nested PDF iframes need inline rendering.
          const url = await getPresignedDownloadUrl(file.s3Bucket, file.s3Key);
          return { ...item, downloadUrl: toAbsoluteDownloadUrl(url) };
        })
      );

      return structuredResult({ data, pagination: page.pagination });
    }
  );

  server.registerTool(
    reportViewTableTool.name,
    toolRegistrationConfig(reportViewTableTool),
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

      const file = await getActiveFileById(args.fileId);
      if (!file || file.instrumentRunId !== run.id) {
        return errorResult(
          `File '${args.fileId}' not found on run '${args.runId}'.`
        );
      }
      const download = await lookupFileForDownload(args.fileId);
      if (!download.ok) {
        return errorResult(
          download.reason === "not_uploaded"
            ? `File '${args.fileId}' has not been uploaded yet.`
            : `File '${args.fileId}' not found on run '${args.runId}'.`
        );
      }

      const full = args.full === true;
      const limit = full
        ? REPORT_VIEW_TABLE_SCAN_CAP
        : Math.min(
            args.limit ?? REPORT_VIEW_TABLE_DEFAULT_LIMIT,
            REPORT_VIEW_TABLE_MAX_LIMIT
          );
      const offset = full ? 0 : Math.max(args.offset ?? 0, 0);

      try {
        const table = await parseCsvPage(
          download.s3Bucket,
          download.s3Key,
          offset,
          limit
        );
        return structuredResult(table);
      } catch (err) {
        console.error(`Failed to parse CSV for file ${file.id}:`, err);
        return errorResult(`Failed to parse CSV for file '${args.fileId}'.`);
      }
    }
  );

  server.registerTool(
    reportViewArtifactTool.name,
    toolRegistrationConfig(reportViewArtifactTool),
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

      if (args.suffix.endsWith("_aunty_plate.json")) {
        const runFiles = await getRunReportFiles(run.id);
        const plate = await getAuntyPlateData(runFiles);
        if (!plate) {
          return errorResult(
            `No artifact ending with '${args.suffix}' on run '${args.runId}'.`
          );
        }
        const plateFile = runFiles.find(
          (file) =>
            file.filename.endsWith("_aunty_plate.json") &&
            file.deletedAt === null
        );
        return structuredResult({
          suffix: args.suffix,
          filename: plateFile?.filename ?? `${args.runId}_aunty_plate.json`,
          artifact: plate,
        });
      }

      const file = await findActiveFileBySuffix(run.id, args.suffix);
      if (!(file?.s3Bucket && file.s3Key)) {
        return errorResult(
          `No artifact ending with '${args.suffix}' on run '${args.runId}'.`
        );
      }

      try {
        const stream = await getS3ObjectStream(file.s3Bucket, file.s3Key);
        const buf = await streamToBuffer(stream);
        const artifact: unknown = JSON.parse(buf.toString("utf8"));
        return structuredResult({
          suffix: args.suffix,
          filename: file.filename,
          artifact,
        });
      } catch (err) {
        console.error(`Failed to parse artifact ${file.s3Key}:`, err);
        return errorResult(
          `Failed to parse JSON artifact ending with '${args.suffix}'.`
        );
      }
    }
  );
}
