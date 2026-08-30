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

function makeSource(callServerTool: unknown) {
  return createMcpReportDataSource({
    app: { callServerTool } as unknown as App,
    instrumentId: "inst",
    runId: "run",
  });
}

describe("createMcpReportDataSource", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("peeks a cached URL and drops it after the TTL", async () => {
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
    const source = makeSource(callServerTool);

    await source.fetchReportItems({ kind: "image", offset: 0, limit: 1 });
    expect(source.peekFileUrl?.(7)).toBe("https://s3.example/a");
    expect(await source.resolveFileUrl(7)).toBe("https://s3.example/a");
    expect(callServerTool).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + URL_CACHE_TTL_MS + 1));
    expect(source.peekFileUrl?.(7)).toBeNull();
  });

  // The host can drop a superseded `tools/call` only if the signal reaches it.
  it("passes the caller's abort signal to the tool call", async () => {
    const callServerTool = vi.fn().mockResolvedValue(
      okResult({
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      })
    );
    const source = makeSource(callServerTool);
    const controller = new AbortController();

    await source.fetchReportItems({
      kind: "image",
      offset: 0,
      limit: 50,
      signal: controller.signal,
    });

    expect(callServerTool.mock.calls[0][1]).toEqual({
      signal: controller.signal,
    });
  });

  // One call, not one per item kind: the tool takes a file id directly.
  it("resolves an uncached file id with a single tool call", async () => {
    const callServerTool = vi
      .fn()
      .mockResolvedValue(
        okResult({ id: 3, filename: "wells.csv", url: "https://s3.example/w" })
      );
    const source = makeSource(callServerTool);

    expect(await source.resolveFileUrl(3)).toBe("https://s3.example/w");
    expect(callServerTool).toHaveBeenCalledTimes(1);
    expect(callServerTool.mock.calls[0][0]).toMatchObject({
      name: "report_view_file_url",
      arguments: { instrumentId: "inst", runId: "run", fileId: 3 },
    });

    // Second read is served from the cache.
    expect(await source.resolveFileUrl(3)).toBe("https://s3.example/w");
    expect(callServerTool).toHaveBeenCalledTimes(1);
  });

  it("reads CSV bytes from S3 rather than through a tool", async () => {
    const callServerTool = vi
      .fn()
      .mockResolvedValue(
        okResult({ id: 9, filename: "wells.csv", url: "https://s3.example/w" })
      );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "n\n0\n1\n2\n",
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = makeSource(callServerTool);

    const first = await source.fetchTableRows(9);
    const second = await source.fetchTableRows(9);

    expect(fetchMock).toHaveBeenCalledWith("https://s3.example/w");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callServerTool).toHaveBeenCalledTimes(1);
    expect(first.columns).toEqual(["n"]);
    expect(first.rows).toEqual([{ n: "0" }, { n: "1" }, { n: "2" }]);
    expect(second).toBe(first);
  });

  it("resolves a file by suffix and caches its URL under the returned id", async () => {
    const callServerTool = vi.fn().mockResolvedValue(
      okResult({
        id: 11,
        filename: "r_aunty_curves.csv",
        url: "https://s3.example/c",
      })
    );
    const source = makeSource(callServerTool);

    const ref = await source.resolveFileBySuffix?.("_aunty_curves.csv");
    expect(ref).toEqual({
      id: 11,
      filename: "r_aunty_curves.csv",
      url: "https://s3.example/c",
    });
    expect(callServerTool.mock.calls[0][0]).toMatchObject({
      arguments: { suffix: "_aunty_curves.csv" },
    });
    expect(source.peekFileUrl?.(11)).toBe("https://s3.example/c");
  });

  it("surfaces the tool's error text", async () => {
    const source = makeSource(
      vi.fn().mockResolvedValue(errorResult("File '3' not found on run 'run'."))
    );
    await expect(source.resolveFileUrl(3)).rejects.toThrow(/not found on run/);
  });

  it("surfaces a failed S3 read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 })
    );
    const source = makeSource(
      vi
        .fn()
        .mockResolvedValue(
          okResult({ id: 9, filename: "w.csv", url: "https://s3.example/w" })
        )
    );
    await expect(source.fetchTableRows(9)).rejects.toThrow(/HTTP 403/);
  });
});
