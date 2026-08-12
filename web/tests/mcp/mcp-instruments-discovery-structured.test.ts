import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMeOutputSchema,
  getSystemStatusOutputSchema,
  globalSearchOutputSchema,
} from "@/lib/mcp/tools/discovery.output";
import {
  getInstrumentFilterOptionsOutputSchema,
  getInstrumentOutputSchema,
  listInstrumentsOutputSchema,
} from "@/lib/mcp/tools/instruments.output";

const { MOCK_LIST_INSTRUMENT, MOCK_INSTRUMENT_DETAIL } = vi.hoisted(() => {
  const MOCK_LIST_INSTRUMENT = {
    id: "test-plate-reader",
    displayName: "Test Plate Reader",
    status: "active" as const,
    instrumentType: "plate_reader" as const,
    filePatterns: ["*.txt"],
    hasDeregisteredWatcher: false,
    runCount: 3,
    runsThisWeek: 1,
    lastRunAt: new Date("2025-01-01T00:00:00.000Z"),
    lastWatcherHeartbeatAt: new Date("2025-01-01T00:00:00.000Z"),
    watcherCount: 1,
    watchersOnline: 1,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
  };
  return {
    MOCK_LIST_INSTRUMENT,
    MOCK_INSTRUMENT_DETAIL: {
      id: MOCK_LIST_INSTRUMENT.id,
      displayName: MOCK_LIST_INSTRUMENT.displayName,
      status: MOCK_LIST_INSTRUMENT.status,
      instrumentType: MOCK_LIST_INSTRUMENT.instrumentType,
      filePatterns: MOCK_LIST_INSTRUMENT.filePatterns,
      runCount: MOCK_LIST_INSTRUMENT.runCount,
      watcherCount: MOCK_LIST_INSTRUMENT.watcherCount,
      watchersOnline: MOCK_LIST_INSTRUMENT.watchersOnline,
      watchersOffline: 0,
      lastWatcherHeartbeatAt: MOCK_LIST_INSTRUMENT.lastWatcherHeartbeatAt,
      activeWatcherId: "watcher-1",
      activeWatcherHostname: "lab-pc",
      activeWatcherDeregistered: false,
      retiredAt: null,
      retiredByUser: null,
      createdAt: MOCK_LIST_INSTRUMENT.createdAt,
      updatedAt: new Date("2024-06-01T00:00:00.000Z"),
    },
  };
});

vi.mock("@/lib/api/instruments", () => ({
  getInstrumentListWithCounts: vi
    .fn()
    .mockResolvedValue([MOCK_LIST_INSTRUMENT]),
  getInstrumentById: vi
    .fn()
    .mockImplementation((id: string) =>
      id === "test-plate-reader" ? MOCK_INSTRUMENT_DETAIL : null
    ),
}));

vi.mock("@/lib/api/instrument-runs", () => ({
  getInstrumentFilterOptions: vi.fn().mockResolvedValue({
    kind: "plate_reader",
    options: {
      wavelengths: ["450"],
      measurementModes: ["Absorbance"],
      measurementTypes: ["Endpoint"],
    },
  }),
}));

vi.mock("@/lib/api/dashboard", () => ({
  getInstrumentSummaries: vi.fn().mockResolvedValue([
    {
      id: "test-plate-reader",
      displayName: "Test Plate Reader",
      status: "active",
      runCount: 3,
      lastRunAt: new Date("2025-01-01T00:00:00.000Z"),
      filesPendingUpload: 0,
      watcherStatus: "online",
    },
  ]),
  getUserById: vi.fn().mockResolvedValue({
    id: "user-1",
    name: "Ada",
    email: "ada@example.com",
    image: null,
    isAdmin: true,
  }),
}));

vi.mock("@/lib/api/search", () => ({
  globalSearch: vi.fn().mockResolvedValue({
    runs: [],
    files: [],
    instruments: [],
    users: [],
    comments: [],
    counts: {
      runs: 0,
      files: 0,
      instruments: 0,
      users: 0,
      comments: 0,
      total: 0,
    },
  }),
}));

import { registerDiscoveryTools } from "@/lib/mcp/tools/discovery";
import { registerInstrumentTools } from "@/lib/mcp/tools/instruments";

function parseText(content: unknown): unknown {
  const text = (content as Array<{ type: string; text: string }>)[0]?.text;
  return JSON.parse(text ?? "");
}

describe("instruments + discovery structuredContent", () => {
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    server = new McpServer(
      { name: "data-hub-test", version: "0.0.0" },
      { capabilities: { tools: {} }, instructions: "test" }
    );
    registerInstrumentTools(server);
    registerDiscoveryTools(server);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("advertises outputSchema for all six tools", async () => {
    const { tools } = await client.listTools();
    for (const name of [
      "list_instruments",
      "get_instrument",
      "get_instrument_filter_options",
      "global_search",
      "get_me",
      "get_system_status",
    ]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.outputSchema, `${name} missing outputSchema`).toBeTruthy();
    }
  });

  it("list_instruments structuredContent matches text and schema", async () => {
    const result = await client.callTool({
      name: "list_instruments",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content) as {
      instruments: Array<{ id: string }>;
    };
    expect(parsed.instruments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "test-plate-reader" }),
      ])
    );
    expect(result.structuredContent).toEqual(parsed);
    expect(listInstrumentsOutputSchema.parse(parsed)).toEqual(parsed);
  });

  it("get_instrument structuredContent matches text and schema", async () => {
    const result = await client.callTool({
      name: "get_instrument",
      arguments: { instrumentId: "test-plate-reader" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content);
    expect(result.structuredContent).toEqual(parsed);
    expect(getInstrumentOutputSchema.parse(parsed)).toEqual(parsed);
  });

  it("get_instrument_filter_options structuredContent matches text and schema", async () => {
    const result = await client.callTool({
      name: "get_instrument_filter_options",
      arguments: { instrumentId: "test-plate-reader" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content);
    expect(result.structuredContent).toEqual(parsed);
    expect(getInstrumentFilterOptionsOutputSchema.parse(parsed)).toEqual(
      parsed
    );
  });

  it("global_search structuredContent matches text and schema", async () => {
    const result = await client.callTool({
      name: "global_search",
      arguments: { query: "plate" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content);
    expect(result.structuredContent).toEqual(parsed);
    expect(globalSearchOutputSchema.parse(parsed)).toEqual(parsed);
  });

  it("get_system_status structuredContent matches text and schema", async () => {
    const result = await client.callTool({
      name: "get_system_status",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content) as {
      instruments: unknown[];
    };
    expect(Array.isArray(parsed.instruments)).toBe(true);
    expect(result.structuredContent).toEqual(parsed);
    expect(getSystemStatusOutputSchema.parse(parsed)).toEqual(parsed);
  });

  it("get_me errors without auth (no structuredContent)", async () => {
    const result = await client.callTool({
      name: "get_me",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(getMeOutputSchema.safeParse({}).success).toBe(false);
  });
});
