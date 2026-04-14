import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the data-access layer so tests run without a database.
// vi.hoisted ensures the mock data is available when vi.mock factories run
// (vi.mock calls are hoisted above all other imports).
// ---------------------------------------------------------------------------

const { MOCK_INSTRUMENT } = vi.hoisted(() => ({
  MOCK_INSTRUMENT: {
    id: "test-plate-reader",
    displayName: "Test Plate Reader",
    status: "active",
    instrumentType: "plate_reader",
    filePatterns: ["*.txt"],
    runCount: 3,
    lastRunAt: new Date("2025-01-01"),
    watcherCount: 1,
    watchersOnline: 1,
    createdAt: new Date("2024-01-01"),
  },
}));

vi.mock("@/lib/api/instruments", () => ({
  getInstrumentListWithCounts: vi.fn().mockResolvedValue([MOCK_INSTRUMENT]),
  getInstrumentById: vi
    .fn()
    .mockImplementation(async (id: string) =>
      id === "test-plate-reader" ? MOCK_INSTRUMENT : null
    ),
}));

vi.mock("@/lib/api/instrument-runs", () => ({
  buildRunListQuery: vi
    .fn()
    .mockResolvedValue({ runs: [], total: 0, page: 1, perPage: 20 }),
  lookupRunByNaturalKey: vi
    .fn()
    .mockImplementation(async (_instId: string, runId: string) =>
      runId === "run-1"
        ? { id: "internal-1", instrumentId: _instId, runId }
        : null
    ),
  getRunFiles: vi.fn().mockResolvedValue([]),
  getRunReportData: vi.fn().mockResolvedValue({ sections: [] }),
  getPlateReaderFilterOptions: vi.fn().mockResolvedValue({
    wavelengths: ["450"],
    measurementModes: ["Absorbance"],
    measurementTypes: ["Endpoint"],
  }),
}));

vi.mock("@/lib/api/dashboard", () => ({
  getInstrumentSummaries: vi.fn().mockResolvedValue([]),
  getInstruments: vi.fn().mockResolvedValue([
    {
      id: "test-plate-reader",
      displayName: "Test Plate Reader",
      instrumentType: "plate_reader",
    },
  ]),
}));

vi.mock("@/lib/api/watchers", () => ({
  getWatcherList: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Now import the registration functions (they'll pick up the mocked deps).
// ---------------------------------------------------------------------------

import { registerPrompts } from "@/lib/mcp/prompts";
import { registerResources } from "@/lib/mcp/resources";
import { registerTools } from "@/lib/mcp/tools";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MCP Protocol (in-memory)", () => {
  let client: Client;
  let mcpServer: McpServer;

  beforeEach(async () => {
    mcpServer = new McpServer(
      { name: "data-hub-test", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );
    registerTools(mcpServer);
    registerResources(mcpServer);
    registerPrompts(mcpServer);

    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
  });

  // ---- Tool registration --------------------------------------------------

  const EXPECTED_TOOLS = [
    "list_instruments",
    "get_instrument",
    "search_runs",
    "get_run",
    "get_run_report_data",
    "list_run_files",
    "get_system_status",
    "list_watchers",
  ] as const;

  it("registers all expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...EXPECTED_TOOLS]));
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
  });

  it("every tool has a non-empty description", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
    }
  });

  it("every tool is annotated as read-only", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} not read-only`).toBe(
        true
      );
    }
  });

  it("tools that require params declare them in inputSchema", async () => {
    const { tools } = await client.listTools();
    const getInstrument = tools.find((t) => t.name === "get_instrument")!;
    expect(getInstrument.inputSchema.properties).toHaveProperty("instrumentId");

    const getRun = tools.find((t) => t.name === "get_run")!;
    expect(getRun.inputSchema.properties).toHaveProperty("instrumentId");
    expect(getRun.inputSchema.properties).toHaveProperty("runId");
  });

  // ---- Tool execution (happy path) ----------------------------------------

  it("list_instruments returns JSON text content", async () => {
    const result = await client.callTool({
      name: "list_instruments",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "test-plate-reader" }),
      ])
    );
  });

  it("get_instrument returns instrument detail", async () => {
    const result = await client.callTool({
      name: "get_instrument",
      arguments: { instrumentId: "test-plate-reader" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    const parsed = JSON.parse(text);
    expect(parsed.id).toBe("test-plate-reader");
  });

  it("search_runs returns paginated results", async () => {
    const result = await client.callTool({
      name: "search_runs",
      arguments: { page: 1, perPage: 10 },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed).toHaveProperty("runs");
    expect(parsed).toHaveProperty("total");
  });

  it("get_system_status returns data", async () => {
    const result = await client.callTool({
      name: "get_system_status",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
  });

  it("list_watchers returns data", async () => {
    const result = await client.callTool({
      name: "list_watchers",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
  });

  // ---- Tool execution (error paths) ---------------------------------------

  it("get_instrument returns error for nonexistent instrument", async () => {
    const result = await client.callTool({
      name: "get_instrument",
      arguments: { instrumentId: "nonexistent" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("not found");
  });

  it("get_run returns error for nonexistent run", async () => {
    const result = await client.callTool({
      name: "get_run",
      arguments: { instrumentId: "test-plate-reader", runId: "nonexistent" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("not found");
  });

  it("get_run_report_data returns error for nonexistent run", async () => {
    const result = await client.callTool({
      name: "get_run_report_data",
      arguments: { instrumentId: "test-plate-reader", runId: "nonexistent" },
    });
    expect(result.isError).toBe(true);
  });

  it("list_run_files returns error for nonexistent run", async () => {
    const result = await client.callTool({
      name: "list_run_files",
      arguments: { instrumentId: "test-plate-reader", runId: "nonexistent" },
    });
    expect(result.isError).toBe(true);
  });

  // ---- Resources -----------------------------------------------------------

  it("lists resources including instruments", async () => {
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === "datahub://instruments")).toBe(true);
  });

  it("reads the instruments resource", async () => {
    const { contents } = await client.readResource({
      uri: "datahub://instruments",
    });
    expect(contents).toHaveLength(1);
    expect(contents[0].mimeType).toBe("application/json");
    expect("text" in contents[0]).toBe(true);
    const parsed = JSON.parse(
      (contents[0] as { uri: string; text: string }).text
    );
    expect(parsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "test-plate-reader" }),
      ])
    );
  });

  it("lists resource templates for plate reader filter options", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(
      resourceTemplates.some((t) => t.uriTemplate.includes("filter-options"))
    ).toBe(true);
  });

  // ---- Prompts -------------------------------------------------------------

  const EXPECTED_PROMPTS = [
    "daily_summary",
    "run_analysis",
    "troubleshoot_instrument",
    "compare_runs",
  ] as const;

  it("lists all expected prompts", async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining([...EXPECTED_PROMPTS]));
    expect(names).toHaveLength(EXPECTED_PROMPTS.length);
  });

  it("every prompt has a non-empty description", async () => {
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) {
      expect(
        prompt.description,
        `${prompt.name} missing description`
      ).toBeTruthy();
    }
  });

  it("daily_summary prompt returns messages", async () => {
    const result = await client.getPrompt({
      name: "daily_summary",
      arguments: { date: "2025-06-01" },
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect((result.messages[0].content as { text: string }).text).toContain(
      "2025-06-01"
    );
  });

  it("run_analysis prompt includes instrument and run in message", async () => {
    const result = await client.getPrompt({
      name: "run_analysis",
      arguments: { instrumentId: "my-inst", runId: "run-42" },
    });
    expect(result.messages).toHaveLength(1);
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("my-inst");
    expect(text).toContain("run-42");
  });

  it("troubleshoot_instrument prompt includes instrument in message", async () => {
    const result = await client.getPrompt({
      name: "troubleshoot_instrument",
      arguments: { instrumentId: "my-inst" },
    });
    expect(result.messages).toHaveLength(1);
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("my-inst");
  });

  it("compare_runs prompt includes both run IDs", async () => {
    const result = await client.getPrompt({
      name: "compare_runs",
      arguments: { instrumentId: "my-inst", runId1: "run-1", runId2: "run-2" },
    });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("run-1");
    expect(text).toContain("run-2");
  });
});
