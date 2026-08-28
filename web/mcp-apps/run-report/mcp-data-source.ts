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
}

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

export function createMcpReportDataSource(args: {
  app: App;
  instrumentId: string;
  runId: string;
}): ReportDataSource {
  const urlCache = new Map<number, string>();

  return {
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
          urlCache.set(withUrl.id, withUrl.downloadUrl);
        }
      }
      return payload;
    },

    async fetchTable({ fileId, offset, limit }) {
      const result = await args.app.callServerTool({
        name: "report_view_table",
        arguments: {
          instrumentId: args.instrumentId,
          runId: args.runId,
          fileId,
          offset,
          limit: Math.min(limit, REPORT_VIEW_TABLE_MAX_LIMIT),
        },
      });
      return structuredPayload<{
        columns: string[];
        rows: Record<string, string>[];
        total: number;
      }>(result);
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

    async resolveFileUrl(fileId: number) {
      const cached = urlCache.get(fileId);
      if (cached) {
        return cached;
      }
      // Kind is required and filters the window, so try every kind. A hit
      // also warms the cache for neighbouring files of that kind.
      await Promise.all(
        REPORT_ITEM_KINDS.map((kind) =>
          this.fetchReportItems({
            kind,
            offset: 0,
            limit: 1,
            anchor: fileId,
          })
        )
      );
      const resolved = urlCache.get(fileId);
      if (resolved) {
        return resolved;
      }
      throw new Error(`No download URL for file ${fileId}`);
    },
  };
}
