import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { REPORT_VIEW_TABLE_MAX_LIMIT } from "@/lib/mcp/ui-apps";
import {
  REPORT_ITEM_KINDS,
  type ReportItemsPage,
} from "@/lib/runs/report-items";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

interface ToolEnvelope<T> {
  artifact?: unknown;
  columns?: string[];
  data?: T;
  filename?: string;
  pagination?: ReportItemsPage["pagination"];
  rows?: Record<string, string>[];
  suffix?: string;
  total?: number;
  truncated?: boolean;
}

interface CachedUrl {
  expiresAt: number;
  url: string;
}

interface CachedTable {
  columns: string[];
  rows: Record<string, string>[];
  total: number;
  truncated: boolean;
}

// Keep in lockstep with `PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS` in
// `lib/s3.ts`. Do not import that module — it pulls the AWS SDK into
// the View bundle. Refresh at 80% of the 15-minute lifetime.
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

export function createMcpReportDataSource(args: {
  app: App;
  instrumentId: string;
  runId: string;
}): ReportDataSource {
  const urlCache = new Map<number, CachedUrl>();
  const tableCache = new Map<number, CachedTable>();

  const source: ReportDataSource = {
    async fetchReportItems({ kind, offset, limit, search, anchor }) {
      const result = await args.app.callServerTool({
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
      });
      const payload = structuredPayload<ReportItemsPage>(result);
      for (const item of payload.data) {
        const withUrl = item as { id: number; downloadUrl?: string };
        if (withUrl.downloadUrl) {
          writeCachedUrl(urlCache, withUrl.id, withUrl.downloadUrl);
        }
      }
      return payload;
    },

    async fetchTable({ fileId, offset, limit }) {
      let parsed = tableCache.get(fileId);
      if (!parsed) {
        // One tool call returns the whole file up to the scan cap. Paging
        // after that is in-memory so a 20k-row CSV is not 100 S3 GETs.
        const result = await args.app.callServerTool({
          name: "report_view_table",
          arguments: {
            instrumentId: args.instrumentId,
            runId: args.runId,
            fileId,
            full: true,
          },
        });
        const payload = structuredPayload<{
          columns: string[];
          rows: Record<string, string>[];
          total: number;
          truncated?: boolean;
        }>(result);
        parsed = {
          columns: payload.columns,
          rows: payload.rows,
          total: payload.total,
          truncated: payload.truncated === true,
        };
        tableCache.set(fileId, parsed);
      }
      return {
        columns: parsed.columns,
        rows: parsed.rows.slice(
          offset,
          offset + Math.min(limit, REPORT_VIEW_TABLE_MAX_LIMIT)
        ),
        total: parsed.total,
        truncated: parsed.truncated,
      };
    },

    async fetchArtifact({ suffix }) {
      const result = await args.app.callServerTool({
        name: "report_view_artifact",
        arguments: {
          instrumentId: args.instrumentId,
          runId: args.runId,
          suffix,
        },
      });
      const payload = structuredPayload<ToolEnvelope<unknown>>(result);
      return payload.artifact ?? payload;
    },

    peekFileUrl(fileId: number) {
      return readCachedUrl(urlCache, fileId) ?? null;
    },

    async resolveFileUrl(fileId: number) {
      const cached = readCachedUrl(urlCache, fileId);
      if (cached) {
        return cached;
      }
      // Kind is required and filters the window, so try every kind. A hit
      // also warms the cache for neighbouring files of that kind.
      await Promise.allSettled(
        REPORT_ITEM_KINDS.map((kind) =>
          source.fetchReportItems({
            kind,
            offset: 0,
            limit: 1,
            anchor: fileId,
          })
        )
      );
      const resolved = readCachedUrl(urlCache, fileId);
      if (resolved) {
        return resolved;
      }
      throw new Error(`No download URL for file ${fileId}`);
    },
  };

  return source;
}
