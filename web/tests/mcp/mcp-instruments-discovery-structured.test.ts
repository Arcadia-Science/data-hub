import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
  const MOCK_WATCHER = {
    id: "watcher-1",
    hostname: "lab-pc",
    osInfo: "Windows 11",
    version: "1.4.2",
    status: "watching" as const,
    statusReason: null,
    lastHeartbeatAt: new Date("2025-01-01T00:00:00.000Z"),
    watchDirectory: "C:\\Data",
    filePatterns: ["*.txt"],
    uploadMode: "auto" as const,
    configState: "none" as const,
    sharedComputerWith: [
      { instrumentId: "test-gel-doc", displayName: "Test Gel Doc" },
    ],
  };
  const MOCK_LIST_INSTRUMENT = {
    id: "test-plate-reader",
    displayName: "Test Plate Reader",
    status: "active" as const,
    instrumentType: "plate_reader" as const,
    filePatterns: ["*.txt"],
    watcher: MOCK_WATCHER,
    connection: { state: "online" as const, reason: null },
    pastWatcherCount: 1,
    activeWatcherId: "watcher-1",
    hasDeregisteredWatcher: true,
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
      watcher: MOCK_WATCHER,
      connection: MOCK_LIST_INSTRUMENT.connection,
      pastWatcherCount: MOCK_LIST_INSTRUMENT.pastWatcherCount,
      runCount: MOCK_LIST_INSTRUMENT.runCount,
      watcherCount: MOCK_LIST_INSTRUMENT.watcherCount,
      watchersOnline: MOCK_LIST_INSTRUMENT.watchersOnline,
      watchersOffline: 0,
      lastWatcherHeartbeatAt: MOCK_LIST_INSTRUMENT.lastWatcherHeartbeatAt,
      activeWatcherId: "watcher-1",
      activeWatcherHostname: "lab-pc",
      activeWatcherWatchDirectory: "C:\\Data",
      activeWatcherDeregistered: false,
      retiredAt: null,
      retiredBy: null,
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
      connection: { state: "restarting", reason: null },
      watcherStatus: "offline",
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

  it("returns the watcher, connection and past watcher count on both tools", async () => {
    const list = parseText(
      (await client.callTool({ name: "list_instruments", arguments: {} }))
        .content
    ) as { instruments: Record<string, unknown>[] };
    const detail = parseText(
      (
        await client.callTool({
          name: "get_instrument",
          arguments: { instrumentId: "test-plate-reader" },
        })
      ).content
    ) as Record<string, unknown>;

    for (const instrument of [list.instruments[0], detail]) {
      expect(instrument).toMatchObject({
        connection: { state: "online", reason: null },
        pastWatcherCount: 1,
        watcher: {
          id: "watcher-1",
          hostname: "lab-pc",
          status: "watching",
          lastHeartbeatAt: "2025-01-01T00:00:00.000Z",
          watchDirectory: "C:\\Data",
          filePatterns: ["*.txt"],
          uploadMode: "auto",
          configState: "none",
          sharedComputerWith: [
            { instrumentId: "test-gel-doc", displayName: "Test Gel Doc" },
          ],
        },
        // The deprecated fields keep their values.
        watcherCount: 1,
        watchersOnline: 1,
        activeWatcherId: "watcher-1",
      });
    }
  });

  it("marks the deprecated instrument fields in the advertised output schema", async () => {
    interface FieldSchema {
      deprecated?: boolean;
      description?: string;
    }
    const { tools } = await client.listTools();
    const fieldsOf = (name: string, path: "detail" | "list") => {
      const schema = tools.find((t) => t.name === name)?.outputSchema as {
        properties: Record<string, FieldSchema & { items?: unknown }>;
      };
      return path === "list"
        ? (
            schema.properties.instruments.items as {
              properties: Record<string, FieldSchema>;
            }
          ).properties
        : (schema.properties as Record<string, FieldSchema>);
    };

    const deprecatedOnList = [
      "watcherCount",
      "watchersOnline",
      "hasDeregisteredWatcher",
      "lastWatcherHeartbeatAt",
      "activeWatcherId",
      "filePatterns",
    ];
    const deprecatedOnDetail = [
      "watcherCount",
      "watchersOnline",
      "watchersOffline",
      "lastWatcherHeartbeatAt",
      "activeWatcherId",
      "activeWatcherHostname",
      "activeWatcherWatchDirectory",
      "activeWatcherDeregistered",
      "filePatterns",
    ];
    for (const [name, path, deprecated] of [
      ["list_instruments", "list", deprecatedOnList],
      ["get_instrument", "detail", deprecatedOnDetail],
    ] as const) {
      const fields = fieldsOf(name, path);
      for (const field of deprecated) {
        expect(fields[field]?.deprecated, `${name}.${field}`).toBe(true);
        expect(fields[field]?.description, `${name}.${field}`).toMatch(
          /^Deprecated\./
        );
      }
      for (const field of ["watcher", "connection", "pastWatcherCount"]) {
        expect(fields[field], `${name}.${field}`).toBeDefined();
        expect(fields[field]?.deprecated, `${name}.${field}`).toBeUndefined();
      }
    }
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

  it("global_search instrument results carry the connection their badge reads", () => {
    const instrument = {
      type: "instrument",
      id: "test-plate-reader",
      displayName: "Test Plate Reader",
      status: "active",
      connection: { state: "offline", reason: "folder_missing" },
      watcherStatus: "offline",
      lastWatcherHeartbeatAt: "2025-01-01T00:00:00.000Z",
      runCount: 3,
      matchReason: "name",
      matchedPattern: null,
    };
    const result = {
      runs: [],
      files: [],
      instruments: [instrument],
      users: [],
      comments: [],
      counts: {
        runs: 0,
        files: 0,
        instruments: 1,
        users: 0,
        comments: 0,
        total: 1,
      },
    };
    expect(globalSearchOutputSchema.parse(result)).toEqual(result);

    // The output schema is strict, so a result without it would be refused.
    const { connection: _connection, ...withoutConnection } = instrument;
    expect(
      globalSearchOutputSchema.safeParse({
        ...result,
        instruments: [withoutConnection],
      }).success
    ).toBe(false);
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
    // A restarting instrument reads `restarting`, not just the legacy offline.
    expect(parsed.instruments[0]).toMatchObject({
      connection: { state: "restarting", reason: null },
    });
  });

  it("get_system_status marks watcherStatus deprecated and requires connection", () => {
    const summary = {
      id: "test-plate-reader",
      displayName: "Test Plate Reader",
      status: "active",
      runCount: 3,
      lastRunAt: null,
      filesPendingUpload: 0,
      connection: { state: "online", reason: null },
      watcherStatus: "online",
    };
    expect(
      getSystemStatusOutputSchema.safeParse({ instruments: [summary] }).success
    ).toBe(true);
    const { connection: _connection, ...withoutConnection } = summary;
    expect(
      getSystemStatusOutputSchema.safeParse({
        instruments: [withoutConnection],
      }).success
    ).toBe(false);

    const json = z.toJSONSchema(getSystemStatusOutputSchema) as unknown as {
      properties: {
        instruments: {
          items: {
            properties: {
              watcherStatus: { deprecated?: boolean; description?: string };
            };
          };
        };
      };
    };
    const field = json.properties.instruments.items.properties.watcherStatus;
    expect(field.deprecated).toBe(true);
    expect(field.description).toMatch(/^Deprecated\./);
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
