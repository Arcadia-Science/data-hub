import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_RUN_UUID = "11111111-1111-4111-a111-111111111111";
const OTHER_RUN_UUID = "22222222-2222-4222-b222-222222222222";

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
}));

vi.mock("@/lib/api/report-items", () => ({
  getReportItemsPage: vi.fn(),
}));

vi.mock("@/lib/api/files", () => ({
  getActiveFileById: vi.fn(),
  getActiveFilesByIds: vi.fn(),
  findActiveFileBySuffix: vi.fn(),
}));

vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...actual,
    getPresignedDownloadUrl: vi
      .fn()
      .mockResolvedValue("https://s3.example.com/signed"),
  };
});

import {
  findActiveFileBySuffix,
  getActiveFileById,
  getActiveFilesByIds,
} from "@/lib/api/files";
import { getReportItemsPage } from "@/lib/api/report-items";
import { registerReportViewTools } from "@/lib/mcp/tools/report-views";
import { getPresignedDownloadUrl } from "@/lib/s3";

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

function errorText(result: { content: unknown }): string {
  const block = (result.content as Array<{ type: string; text?: string }>).find(
    (item) => item.type === "text"
  );
  return block?.text ?? "";
}

const RUN_ARGS = { instrumentId: "test-plate-reader", runId: "run-1" };

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
        contentType: "image/png",
        filename: "gel.png",
        s3Bucket: "raw",
        s3Key: "gel.png",
      },
    ]);

    const result = await client.callTool({
      name: "report_view_items",
      arguments: { ...RUN_ARGS, kind: "image" },
    });

    expect(result.isError).toBeFalsy();
    expect(parseStructured(result).data).toEqual([
      {
        id: 42,
        filename: "gel.png",
        downloadUrl: "https://s3.example.com/signed",
      },
    ]);
    expect(getPresignedDownloadUrl).toHaveBeenCalledWith("raw", "gel.png", {
      contentType: "image/png",
      disposition: "inline",
      filename: "gel.png",
    });
  });

  it("report_view_file_url signs a file looked up by id", async () => {
    vi.mocked(getActiveFileById).mockResolvedValue({
      id: 42,
      filename: "wells.csv",
      instrumentRunId: MOCK_RUN_UUID,
      s3Bucket: "processed",
      s3Key: "wells.csv",
    } as never);

    const result = await client.callTool({
      name: "report_view_file_url",
      arguments: { ...RUN_ARGS, fileId: 42 },
    });

    expect(result.isError).toBeFalsy();
    expect(parseStructured(result)).toEqual({
      id: 42,
      filename: "wells.csv",
      url: "https://s3.example.com/signed",
    });
    expect(getPresignedDownloadUrl).toHaveBeenCalledWith(
      "processed",
      "wells.csv",
      {
        contentType: "text/csv",
        disposition: "inline",
        filename: "wells.csv",
      }
    );
  });

  it("report_view_file_url signs a file looked up by suffix", async () => {
    vi.mocked(findActiveFileBySuffix).mockResolvedValue({
      id: 7,
      filename: "run_aunty_plate.json",
      instrumentRunId: MOCK_RUN_UUID,
      s3Bucket: "processed",
      s3Key: "run_aunty_plate.json",
    } as never);

    const result = await client.callTool({
      name: "report_view_file_url",
      arguments: { ...RUN_ARGS, suffix: "_aunty_plate.json" },
    });

    expect(result.isError).toBeFalsy();
    expect(parseStructured(result).id).toBe(7);
    expect(findActiveFileBySuffix).toHaveBeenCalledWith(
      MOCK_RUN_UUID,
      "_aunty_plate.json"
    );
  });

  // The id lookup is not run-scoped, so the handler has to check the run
  // itself or a caller could read any file by guessing ids.
  it("report_view_file_url refuses a file belonging to another run", async () => {
    vi.mocked(getActiveFileById).mockResolvedValue({
      id: 42,
      filename: "secret.csv",
      instrumentRunId: OTHER_RUN_UUID,
      s3Bucket: "raw",
      s3Key: "secret.csv",
    } as never);

    const result = await client.callTool({
      name: "report_view_file_url",
      arguments: { ...RUN_ARGS, fileId: 42 },
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("not found on run");
    expect(getPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("report_view_file_url reports a file with no bytes yet", async () => {
    vi.mocked(getActiveFileById).mockResolvedValue({
      id: 42,
      filename: "pending.csv",
      instrumentRunId: MOCK_RUN_UUID,
      s3Bucket: null,
      s3Key: null,
    } as never);

    const result = await client.callTool({
      name: "report_view_file_url",
      arguments: { ...RUN_ARGS, fileId: 42 },
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("has not been uploaded yet");
  });

  it("report_view_file_url requires an id or a suffix", async () => {
    const result = await client.callTool({
      name: "report_view_file_url",
      arguments: RUN_ARGS,
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("Pass either");
  });

  it("report_view_file_url reports an unknown run", async () => {
    const result = await client.callTool({
      name: "report_view_file_url",
      arguments: { ...RUN_ARGS, runId: "nope", fileId: 42 },
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("not found for instrument");
  });
});
