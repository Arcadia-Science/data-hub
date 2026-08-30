import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parse } from "csv-parse/browser/esm/sync";
import type { ReportItemsPage } from "@/lib/runs/report-items";
import type {
  ReportDataSource,
  ReportFileRef,
  ReportTableRows,
} from "@/lib/runs/view-data-source";

interface CachedUrl {
  expiresAt: number;
  url: string;
}

// 80% of `PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS` in `lib/s3.ts`, copied rather
// than imported because that module pulls the AWS SDK into the View bundle.
export const URL_CACHE_TTL_MS = 15 * 60 * 1000 * 0.8;

function structuredPayload<T>(result: CallToolResult): T {
  if (result.isError) {
    const text = result.content
      ?.map((block) => ("text" in block ? block.text : ""))
      .join("\n");
    throw new Error(text || "Tool call failed");
  }
  if (result.structuredContent != null) {
    return result.structuredContent as T;
  }
  const textBlock = result.content?.find((block) => block.type === "text");
  if (textBlock && "text" in textBlock) {
    return JSON.parse(textBlock.text) as T;
  }
  throw new Error("Tool result had no structured content");
}

function readCachedUrl(
  cache: Map<number, CachedUrl>,
  fileId: number
): string | undefined {
  const hit = cache.get(fileId);
  if (!hit) {
    return;
  }
  if (Date.now() >= hit.expiresAt) {
    cache.delete(fileId);
    return;
  }
  return hit.url;
}

function writeCachedUrl(
  cache: Map<number, CachedUrl>,
  fileId: number,
  url: string
): void {
  cache.set(fileId, { url, expiresAt: Date.now() + URL_CACHE_TTL_MS });
}

async function fetchText(url: string, what: string): Promise<string> {
  // Reaches S3 directly, so the bytes never pass through the server. The
  // resource's `connectDomains` and the buckets' `*` CORS rule allow it.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${what} (HTTP ${response.status})`);
  }
  return await response.text();
}

export function createMcpReportDataSource(args: {
  app: App;
  instrumentId: string;
  runId: string;
}): ReportDataSource {
  const urlCache = new Map<number, CachedUrl>();
  const tableCache = new Map<number, ReportTableRows>();

  async function callFileUrl(
    params: { fileId: number } | { suffix: string }
  ): Promise<ReportFileRef> {
    const result = await args.app.callServerTool({
      name: "report_view_file_url",
      arguments: {
        instrumentId: args.instrumentId,
        runId: args.runId,
        ...params,
      },
    });
    const ref = structuredPayload<ReportFileRef>(result);
    writeCachedUrl(urlCache, ref.id, ref.url);
    return ref;
  }

  const source: ReportDataSource = {
    async fetchReportItems({ kind, offset, limit, search, anchor, signal }) {
      // Aborting makes the SDK notify the host so it can drop the in-flight
      // `tools/call` instead of waiting on a window nobody will read.
      const result = await args.app.callServerTool(
        {
          name: "report_view_items",
          arguments: {
            instrumentId: args.instrumentId,
            runId: args.runId,
            kind,
            offset,
            limit,
            search,
            anchor,
          },
        },
        { signal }
      );
      const payload = structuredPayload<ReportItemsPage>(result);
      for (const item of payload.data) {
        const withUrl = item as { id: number; downloadUrl?: string };
        if (withUrl.downloadUrl) {
          writeCachedUrl(urlCache, withUrl.id, withUrl.downloadUrl);
        }
      }
      return payload;
    },

    async fetchTableRows(fileId) {
      const cached = tableCache.get(fileId);
      if (cached) {
        return cached;
      }
      const url = await source.resolveFileUrl(fileId);
      const rows = parse(await fetchText(url, `file ${fileId}`), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[];
      const parsed: ReportTableRows = {
        columns: rows.length === 0 ? [] : Object.keys(rows[0]),
        rows,
      };
      tableCache.set(fileId, parsed);
      return parsed;
    },

    peekFileUrl(fileId: number) {
      return readCachedUrl(urlCache, fileId) ?? null;
    },

    async resolveFileUrl(fileId: number) {
      const cached = readCachedUrl(urlCache, fileId);
      if (cached) {
        return cached;
      }
      return (await callFileUrl({ fileId })).url;
    },

    resolveFileBySuffix(suffix: string) {
      return callFileUrl({ suffix });
    },
  };

  return source;
}
