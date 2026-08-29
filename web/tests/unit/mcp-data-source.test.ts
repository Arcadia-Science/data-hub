import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMcpReportDataSource,
  URL_CACHE_TTL_MS,
} from "@/mcp-apps/run-report/mcp-data-source";

function okResult(structuredContent: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  } as CallToolResult;
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  } as CallToolResult;
}

describe("createMcpReportDataSource", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("peeks a cached URL and refreshes after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const callServerTool = vi.fn().mockResolvedValue(
      okResult({
        data: [
          { id: 7, filename: "a.png", downloadUrl: "https://s3.example/a" },
        ],
        pagination: { limit: 1, offset: 0, total: 1 },
      })
    );
    const source = createMcpReportDataSource({
      app: { callServerTool } as unknown as App,
      instrumentId: "inst",
      runId: "run",
    });

    await source.fetchReportItems({
      kind: "image",
      offset: 0,
      limit: 1,
    });
    expect(source.peekFileUrl?.(7)).toBe("https://s3.example/a");
    expect(await source.resolveFileUrl(7)).toBe("https://s3.example/a");
    expect(callServerTool).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + URL_CACHE_TTL_MS + 1));
    expect(source.peekFileUrl?.(7)).toBeNull();
  });

  it("loads a CSV once with full:true and pages from memory", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ n: String(i) }));
    const callServerTool = vi.fn().mockResolvedValue(
      okResult({
        columns: ["n"],
        rows,
        total: 5,
        truncated: false,
      })
    );
    const source = createMcpReportDataSource({
      app: { callServerTool } as unknown as App,
      instrumentId: "inst",
      runId: "run",
    });

    const first = await source.fetchTable({ fileId: 9, offset: 0, limit: 2 });
    const second = await source.fetchTable({ fileId: 9, offset: 2, limit: 2 });

    expect(callServerTool).toHaveBeenCalledTimes(1);
    expect(callServerTool.mock.calls[0][0]).toMatchObject({
      name: "report_view_table",
      arguments: { fileId: 9, full: true },
    });
    expect(first.rows).toEqual([{ n: "0" }, { n: "1" }]);
    expect(second.rows).toEqual([{ n: "2" }, { n: "3" }]);
    expect(first.truncated).toBe(false);
  });

  it("keeps a successful URL when another kind lookup fails", async () => {
    const callServerTool = vi.fn(
      ({
        name,
        arguments: args,
      }: {
        name: string;
        arguments: { kind?: string };
      }) => {
        if (name === "report_view_items" && args.kind === "image") {
          return okResult({
            data: [
              { id: 3, filename: "a.png", downloadUrl: "https://s3.example/a" },
            ],
            pagination: { limit: 1, offset: 0, total: 1 },
          });
        }
        return errorResult("boom");
      }
    );
    const source = createMcpReportDataSource({
      app: { callServerTool } as unknown as App,
      instrumentId: "inst",
      runId: "run",
    });

    await expect(source.resolveFileUrl(3)).resolves.toBe(
      "https://s3.example/a"
    );
    expect(callServerTool).toHaveBeenCalledTimes(4);
  });
});
