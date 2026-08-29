import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_RUN_UUID = "11111111-1111-4111-a111-111111111111";

vi.mock("@/lib/auth", () => ({
  authBaseURL: "http://localhost:3000",
}));

vi.mock("@/lib/mcp/tools/helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mcp/tools/helpers")>();
  return {
    ...actual,
    getMcpUserId: vi.fn(() => "user-1"),
  };
});

vi.mock("@/lib/api/instrument-runs", () => ({
  lookupRunByNaturalKey: vi.fn(async (_instrumentId: string, runId: string) =>
    runId === "run-1"
      ? { id: MOCK_RUN_UUID, instrumentId: "test-plate-reader", runId: "run-1" }
      : null
  ),
  getRunReportFiles: vi.fn(),
  getAuntyPlateData: vi.fn(),
}));

vi.mock("@/lib/api/report-items", () => ({
  getReportItemsPage: vi.fn(),
}));

vi.mock("@/lib/api/files", () => ({
  getActiveFileById: vi.fn(),
  getActiveFilesByIds: vi.fn(),
  lookupFileForDownload: vi.fn(),
  findActiveFileBySuffix: vi.fn(),
}));

vi.mock("@/lib/s3", () => ({
  getPresignedDownloadUrl: vi
    .fn()
    .mockResolvedValue("https://s3.example.com/signed"),
  getS3ObjectStream: vi.fn(),
}));

vi.mock("@/lib/runs/parse-csv-page", () => ({
  parseCsvPage: vi.fn(),
}));

import {
  findActiveFileBySuffix,
  getActiveFileById,
  getActiveFilesByIds,
  lookupFileForDownload,
} from "@/lib/api/files";
import {
  getAuntyPlateData,
  getRunReportFiles,
} from "@/lib/api/instrument-runs";
import { getReportItemsPage } from "@/lib/api/report-items";
import { registerReportViewTools } from "@/lib/mcp/tools/report-views";
import { parseCsvPage } from "@/lib/runs/parse-csv-page";
import { getS3ObjectStream } from "@/lib/s3";

function parseStructured(result: {
  structuredContent?: unknown;
  content: unknown;
}): Record<string, unknown> {
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    return result.structuredContent as Record<string, unknown>;
  }
  const block = (result.content as Array<{ type: string; text?: string }>).find(
    (item) => item.type === "text"
  );
  return JSON.parse(block?.text ?? "{}") as Record<string, unknown>;
}

describe("report_view tools (authenticated)", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    server = new McpServer(
      { name: "data-hub-test", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    registerReportViewTools(server);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    vi.clearAllMocks();
  });

  it("report_view_items returns download URLs", async () => {
    vi.mocked(getReportItemsPage).mockResolvedValue({
      data: [{ id: 42, filename: "gel.png" }],
      pagination: { limit: 50, offset: 0, total: 1 },
    });
    vi.mocked(getActiveFilesByIds).mockResolvedValue([
      {
        id: 42,
        s3Bucket: "raw",
        s3Key: "gel.png",
      } as never,
    ]);

    const result = await client.callTool({
      name: "report_view_items",
      arguments: {
        instrumentId: "test-plate-reader",
        runId: "run-1",
        kind: "image",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseStructured(result);
    expect(parsed.data).toEqual([
      {
        id: 42,
        filename: "gel.png",
        downloadUrl: "https://s3.example.com/signed",
      },
    ]);
  });

  it("report_view_table clamps limit and forwards offset", async () => {
    vi.mocked(getActiveFileById).mockResolvedValue({
      id: 42,
      instrumentRunId: MOCK_RUN_UUID,
    } as never);
    vi.mocked(lookupFileForDownload).mockResolvedValue({
      ok: true,
      filename: "data.csv",
      s3Bucket: "raw",
      s3Key: "data.csv",
    });
    vi.mocked(parseCsvPage).mockResolvedValue({
      columns: ["n"],
      rows: [{ n: "1" }],
      total: 3,
      truncated: false,
    });

    const result = await client.callTool({
      name: "report_view_table",
      arguments: {
        instrumentId: "test-plate-reader",
        runId: "run-1",
        fileId: 42,
        offset: 2,
        limit: 200,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(parseCsvPage).toHaveBeenCalledWith("raw", "data.csv", 2, 200);
  });

  it("report_view_table rejects a limit above the schema max", async () => {
    const result = await client.callTool({
      name: "report_view_table",
      arguments: {
        instrumentId: "test-plate-reader",
        runId: "run-1",
        fileId: 42,
        limit: 201,
      },
    });
    expect(result.isError).toBe(true);
    expect(parseCsvPage).not.toHaveBeenCalled();
  });

  it("report_view_table full=true reads from row 0 up to the scan cap", async () => {
    vi.mocked(getActiveFileById).mockResolvedValue({
      id: 42,
      instrumentRunId: MOCK_RUN_UUID,
    } as never);
    vi.mocked(lookupFileForDownload).mockResolvedValue({
      ok: true,
      filename: "data.csv",
      s3Bucket: "raw",
      s3Key: "data.csv",
    });
    vi.mocked(parseCsvPage).mockResolvedValue({
      columns: ["n"],
      rows: [{ n: "1" }],
      total: 50_000,
      truncated: true,
    });

    const result = await client.callTool({
      name: "report_view_table",
      arguments: {
        instrumentId: "test-plate-reader",
        runId: "run-1",
        fileId: 42,
        full: true,
        offset: 99,
        limit: 10,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(parseCsvPage).toHaveBeenCalledWith("raw", "data.csv", 0, 50_000);
    expect(parseStructured(result).truncated).toBe(true);
  });

  it("report_view_artifact returns Aunty plate data", async () => {
    const plate = { plate: { wells: [] }, curvesFileId: 9 };
    vi.mocked(getRunReportFiles).mockResolvedValue([
      {
        filename: "run-1_aunty_plate.json",
        deletedAt: null,
      } as never,
    ]);
    vi.mocked(getAuntyPlateData).mockResolvedValue(plate as never);

    const result = await client.callTool({
      name: "report_view_artifact",
      arguments: {
        instrumentId: "test-plate-reader",
        runId: "run-1",
        suffix: "_aunty_plate.json",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(parseStructured(result)).toMatchObject({
      suffix: "_aunty_plate.json",
      filename: "run-1_aunty_plate.json",
      artifact: plate,
    });
  });

  it("report_view_artifact parses a JSON suffix file", async () => {
    vi.mocked(findActiveFileBySuffix).mockResolvedValue({
      filename: "run-1_meta.json",
      s3Bucket: "raw",
      s3Key: "run-1_meta.json",
    } as never);
    const { Readable } = await import("node:stream");
    vi.mocked(getS3ObjectStream).mockResolvedValue(
      Readable.from([Buffer.from('{"ok":true}')]) as never
    );

    const result = await client.callTool({
      name: "report_view_artifact",
      arguments: {
        instrumentId: "test-plate-reader",
        runId: "run-1",
        suffix: "_meta.json",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(parseStructured(result)).toMatchObject({
      suffix: "_meta.json",
      filename: "run-1_meta.json",
      artifact: { ok: true },
    });
  });
});
