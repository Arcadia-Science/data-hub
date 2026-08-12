import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the data-access layer so tests run without a database.
// vi.hoisted ensures the mock data is available when vi.mock factories run
// (vi.mock calls are hoisted above all other imports).
// ---------------------------------------------------------------------------

const {
  MOCK_INSTRUMENT,
  MOCK_GEL_DOC_INSTRUMENT,
  MOCK_INSTRUMENT_DETAIL,
  MOCK_GEL_DOC_INSTRUMENT_DETAIL,
  MOCK_GENERIC_INSTRUMENT_DETAIL,
  MOCK_FILE,
  MOCK_RUN_LIST_ROW,
  mockRunDetail,
  MOCK_RUN_UUID_1,
  MOCK_RUN_UUID_2,
} = vi.hoisted(() => {
  // Zod's uuid() checks RFC variant bits — all-ones / sequential hex fails.
  const MOCK_RUN_UUID_1 = "11111111-1111-4111-a111-111111111111";
  const MOCK_RUN_UUID_2 = "22222222-2222-4222-b222-222222222222";
  const MOCK_RUN_LIST_ROW = {
    id: MOCK_RUN_UUID_1,
    instrument_id: "test-plate-reader",
    instrument_display_name: "Test Plate Reader",
    instrument_type: "plate_reader" as const,
    run_id: "run-1",
    source: "watcher" as const,
    metadata: {},
    created_at: new Date("2025-01-01T00:00:00.000Z"),
    acquired_at: new Date("2025-01-01T00:00:00.000Z"),
    updated_at: new Date("2025-01-01T00:00:00.000Z"),
    deleted_at: null,
    file_count: 1,
    files_completed: 1,
    files_failed: 0,
    files_pending_upload: 0,
    files_uploaded: 0,
    files_processing: 0,
    total_size_bytes: 1234,
    error_messages: [] as string[],
    attributions: [] as Array<{
      userId: string;
      displayName: string;
      initials: string;
      avatarUrl: string | null;
    }>,
  };
  function mockRunDetail(instrumentId: string, runId: string, id: string) {
    return {
      id,
      instrumentId,
      runId,
      source: "watcher" as const,
      watcherId: null,
      metadata: {},
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      acquiredAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      deletedAt: null,
      deletedBy: null,
      instrumentDisplayName: "Test Plate Reader",
      instrumentType: "plate_reader" as const,
      deletedByUser: null,
      attributions: [] as Array<{
        userId: string;
        displayName: string;
        initials: string;
        avatarUrl: string | null;
      }>,
    };
  }
  const listBase = {
    hasDeregisteredWatcher: false,
    runsThisWeek: 0,
    lastWatcherHeartbeatAt: new Date("2025-01-01"),
  };
  const detailBase = {
    watchersOffline: 0,
    activeWatcherId: "watcher-1",
    activeWatcherHostname: "lab-pc",
    activeWatcherDeregistered: false,
    retiredAt: null,
    retiredByUser: null,
    updatedAt: new Date("2024-06-01"),
    lastWatcherHeartbeatAt: new Date("2025-01-01"),
  };
  const MOCK_INSTRUMENT = {
    id: "test-plate-reader",
    displayName: "Test Plate Reader",
    status: "active" as const,
    instrumentType: "plate_reader",
    filePatterns: ["*.txt"],
    runCount: 3,
    lastRunAt: new Date("2025-01-01"),
    watcherCount: 1,
    watchersOnline: 1,
    createdAt: new Date("2024-01-01"),
    ...listBase,
    runsThisWeek: 1,
  };
  const MOCK_GEL_DOC_INSTRUMENT = {
    id: "test-gel-doc",
    displayName: "Test Gel Doc",
    status: "active" as const,
    instrumentType: "gel_doc",
    filePatterns: ["*.tif"],
    runCount: 1,
    lastRunAt: new Date("2025-01-01"),
    watcherCount: 1,
    watchersOnline: 1,
    createdAt: new Date("2024-01-01"),
    ...listBase,
  };
  const MOCK_GENERIC_INSTRUMENT = {
    id: "test-generic",
    displayName: "Test Generic",
    status: "active" as const,
    instrumentType: "generic",
    filePatterns: ["*.dat"],
    runCount: 0,
    lastRunAt: null,
    watcherCount: 0,
    watchersOnline: 0,
    createdAt: new Date("2024-01-01"),
    ...listBase,
    lastWatcherHeartbeatAt: null,
  };
  return {
    MOCK_INSTRUMENT,
    MOCK_GEL_DOC_INSTRUMENT,
    MOCK_INSTRUMENT_DETAIL: {
      id: MOCK_INSTRUMENT.id,
      displayName: MOCK_INSTRUMENT.displayName,
      status: MOCK_INSTRUMENT.status,
      instrumentType: MOCK_INSTRUMENT.instrumentType,
      filePatterns: MOCK_INSTRUMENT.filePatterns,
      runCount: MOCK_INSTRUMENT.runCount,
      watcherCount: MOCK_INSTRUMENT.watcherCount,
      watchersOnline: MOCK_INSTRUMENT.watchersOnline,
      createdAt: MOCK_INSTRUMENT.createdAt,
      ...detailBase,
    },
    MOCK_GEL_DOC_INSTRUMENT_DETAIL: {
      id: MOCK_GEL_DOC_INSTRUMENT.id,
      displayName: MOCK_GEL_DOC_INSTRUMENT.displayName,
      status: MOCK_GEL_DOC_INSTRUMENT.status,
      instrumentType: MOCK_GEL_DOC_INSTRUMENT.instrumentType,
      filePatterns: MOCK_GEL_DOC_INSTRUMENT.filePatterns,
      runCount: MOCK_GEL_DOC_INSTRUMENT.runCount,
      watcherCount: MOCK_GEL_DOC_INSTRUMENT.watcherCount,
      watchersOnline: MOCK_GEL_DOC_INSTRUMENT.watchersOnline,
      createdAt: MOCK_GEL_DOC_INSTRUMENT.createdAt,
      ...detailBase,
    },
    MOCK_GENERIC_INSTRUMENT_DETAIL: {
      id: MOCK_GENERIC_INSTRUMENT.id,
      displayName: MOCK_GENERIC_INSTRUMENT.displayName,
      status: MOCK_GENERIC_INSTRUMENT.status,
      instrumentType: MOCK_GENERIC_INSTRUMENT.instrumentType,
      filePatterns: MOCK_GENERIC_INSTRUMENT.filePatterns,
      runCount: MOCK_GENERIC_INSTRUMENT.runCount,
      watcherCount: MOCK_GENERIC_INSTRUMENT.watcherCount,
      watchersOnline: MOCK_GENERIC_INSTRUMENT.watchersOnline,
      createdAt: MOCK_GENERIC_INSTRUMENT.createdAt,
      ...detailBase,
      activeWatcherId: null,
      activeWatcherHostname: null,
      lastWatcherHeartbeatAt: null,
    },
    MOCK_FILE: {
      id: 42,
      instrumentRunId: MOCK_RUN_UUID_1,
      filename: "data.csv",
      relativePath: "data.csv",
      status: "completed",
      s3Bucket: "test-bucket",
      s3Key: "path/to/data.csv",
      contentType: "text/csv",
      sizeBytes: 1234,
      category: "raw",
      metadata: {},
      errorMessage: null,
      detectedAt: null,
      uploadRequestedAt: null,
      uploadedAt: new Date("2025-01-01T00:00:00Z"),
      processedAt: new Date("2025-01-01T00:00:00Z"),
      fileCreatedAt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      deletedAt: null,
    },
    MOCK_RUN_LIST_ROW,
    mockRunDetail,
    MOCK_RUN_UUID_1,
    MOCK_RUN_UUID_2,
  };
});

vi.mock("@/lib/api/instruments", () => ({
  // The generic instrument is intentionally omitted from the list so we can
  // assert that non-filterable types are filtered out of the filter-options
  // resource template list.
  getInstrumentListWithCounts: vi
    .fn()
    .mockResolvedValue([MOCK_INSTRUMENT, MOCK_GEL_DOC_INSTRUMENT]),
  getInstrumentById: vi.fn().mockImplementation((id: string) => {
    if (id === "test-plate-reader") {
      return MOCK_INSTRUMENT_DETAIL;
    }
    if (id === "test-gel-doc") {
      return MOCK_GEL_DOC_INSTRUMENT_DETAIL;
    }
    if (id === "test-generic") {
      return MOCK_GENERIC_INSTRUMENT_DETAIL;
    }
    return null;
  }),
}));

vi.mock("@/lib/api/instrument-runs", () => ({
  buildRunListQuery: vi.fn().mockResolvedValue({
    data: [
      MOCK_RUN_LIST_ROW,
      { ...MOCK_RUN_LIST_ROW, id: MOCK_RUN_UUID_2, run_id: "run-2" },
    ],
    pagination: { page: 1, per_page: 50, total: 2, total_pages: 1 },
  }),
  lookupRunByNaturalKey: vi
    .fn()
    .mockImplementation((_instId: string, runId: string) => {
      if (runId === "run-1") {
        return mockRunDetail(_instId, runId, MOCK_RUN_UUID_1);
      }
      if (runId === "run-2") {
        return mockRunDetail(_instId, runId, MOCK_RUN_UUID_2);
      }
      return null;
    }),
  lookupRunUuidsByNaturalKeys: vi
    .fn()
    .mockImplementation((_instId: string, runIds: string[]) => {
      const map = new Map<string, string>();
      for (const runId of runIds) {
        if (runId === "run-1") {
          map.set(runId, MOCK_RUN_UUID_1);
        }
        if (runId === "run-2") {
          map.set(runId, MOCK_RUN_UUID_2);
        }
      }
      return map;
    }),
  getRunFilesPage: vi.fn().mockResolvedValue({
    data: [],
    pagination: { page: 1, per_page: 50, total: 0, total_pages: 0 },
  }),
  getInstrumentFilterOptions: vi
    .fn()
    .mockImplementation((instrumentType: string) => {
      if (instrumentType === "plate_reader") {
        return {
          kind: "plate_reader",
          options: {
            wavelengths: ["450"],
            measurementModes: ["Absorbance"],
            measurementTypes: ["Endpoint"],
          },
        };
      }
      if (instrumentType === "gel_doc") {
        return {
          kind: "gel_doc",
          options: {
            captureTypes: ["Chemi"],
            imagingModes: ["Single"],
            wavelengths: ["520"],
            colors: ["Green"],
          },
        };
      }
      if (instrumentType === "qpcr") {
        return {
          kind: "qpcr",
          options: { dyeChannels: ["SYBR"] },
        };
      }
      return { kind: "default" };
    }),
  getAttributionsByRunIds: vi.fn().mockResolvedValue(new Map()),
  getRanByFilterOptions: vi
    .fn()
    .mockResolvedValue([{ userId: "u-1", displayName: "Alice" }]),
}));

// The write-tool happy path goes through the raw Drizzle client. Stub out
// the chainable methods that `claim_run` / `unclaim_run` use so the tools
// can be invoked without a real database. A real end-to-end write test
// lives in the HTTP integration suite.
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  },
}));

vi.mock("@/lib/api/dashboard", () => ({
  getInstrumentSummaries: vi.fn().mockResolvedValue([]),
  getInstruments: vi.fn().mockResolvedValue([
    {
      id: "test-plate-reader",
      displayName: "Test Plate Reader",
      status: "active",
    },
    {
      id: "test-gel-doc",
      displayName: "Test Gel Doc",
      status: "active",
    },
  ]),
  getUserById: vi.fn().mockImplementation(async (id: string) =>
    id === "user-from-auth"
      ? {
          id: "user-from-auth",
          name: "Test User",
          email: "test@example.com",
          image: null,
          isAdmin: false,
        }
      : null
  ),
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

vi.mock("@/lib/api/watchers", () => ({
  getWatcherList: vi.fn().mockResolvedValue([
    {
      id: "watcher-1",
      instrumentId: "test-plate-reader",
      instrumentDisplayName: "Test Plate Reader",
      hostname: "bench-pc",
      watcherVersion: "1.0.0",
      effectiveStatus: "watching",
      lastHeartbeatAt: new Date("2025-01-01T12:00:00Z"),
      createdAt: new Date("2024-01-01T00:00:00Z"),
      deletedAt: null,
    },
  ]),
  getWatcherById: vi.fn().mockImplementation((id: string) => {
    if (id !== "watcher-1") {
      return null;
    }
    return {
      id: "watcher-1",
      instrumentId: "test-plate-reader",
      instrumentDisplayName: "Test Plate Reader",
      hostname: "bench-pc",
      watcherVersion: "1.0.0",
      effectiveStatus: "watching",
      lastHeartbeatAt: new Date("2025-01-01T12:00:00Z"),
      createdAt: new Date("2024-01-01T00:00:00Z"),
      deletedAt: null,
      osInfo: "linux",
      configYaml: "watch: true\n",
      configChecksum: "abc123",
      updatedAt: new Date("2025-01-01T00:00:00Z"),
      deregisteredByUser: null,
    };
  }),
  getWatcherEvents: vi.fn().mockResolvedValue({
    rows: [
      {
        id: 1,
        eventType: "file_uploaded",
        message: "uploaded data.csv",
        details: { filename: "data.csv" },
        timestamp: new Date("2025-01-01T12:00:00Z"),
      },
    ],
    total: 1,
  }),
  getWatcherHeartbeats: vi.fn().mockResolvedValue({
    rows: [
      {
        id: 1,
        timestamp: new Date("2025-01-01T12:00:00Z"),
        status: "watching",
        uploadMode: "auto",
        filesUploadedSinceLast: 2,
        runsReportedSinceLast: 1,
        errorsSinceLast: 0,
        uptimeSeconds: 3600,
      },
    ],
    total: 1,
  }),
}));

vi.mock("@/lib/api/run-reports", () => ({
  buildRunReport: vi.fn().mockResolvedValue({
    ok: true,
    instrumentId: "test-plate-reader",
    runId: "run-1",
    instrumentType: "plate_reader",
    metadata: {},
    fileCounts: { completed: 1 },
    processedCsv: {
      rowCount: 1,
      columns: ["Well", "Value"],
      sampleRows: [{ Well: "A1", Value: "0.1" }],
      sampleRowLimit: 20,
      truncated: false,
    },
    images: [],
    reportFiles: [],
    failureSummary: { byStatus: { completed: 1 }, failed: [], totalFiles: 1 },
  }),
  getRunFailureSummary: vi.fn().mockResolvedValue({
    byStatus: { completed: 1 },
    failed: [],
    totalFiles: 1,
  }),
}));

vi.mock("@/lib/api/files", () => ({
  getActiveFileById: vi
    .fn()
    .mockImplementation(async (id: number) => (id === 42 ? MOCK_FILE : null)),
  lookupFileForDownload: vi.fn().mockImplementation((id: number) => {
    if (id === 42) {
      return {
        ok: true,
        filename: MOCK_FILE.filename,
        s3Bucket: MOCK_FILE.s3Bucket,
        s3Key: MOCK_FILE.s3Key,
      };
    }
    if (id === 99) {
      return { ok: false, reason: "not_uploaded" };
    }
    return { ok: false, reason: "not_found" };
  }),
  dismissFile: vi.fn().mockResolvedValue({
    ok: true,
    id: 1,
    filename: "a.txt",
    deletedAt: new Date(),
    alreadyApplied: false,
  }),
}));

// `prepareRunArchive` owns the cache-hit / build-kickoff branch on the
// MCP `get_run_archive` tool. The default mock returns a `ready`
// response so the happy-path test asserts on a presigned URL; the
// "building" branch has its own override later in the suite.
vi.mock("@/lib/api/run-archive", () => ({
  prepareRunArchive: vi.fn().mockResolvedValue({
    ok: true,
    status: "ready",
    downloadUrl: "https://s3.example.com/archive-signed-url",
    sizeBytes: 4096,
    filename: "run-1.zip",
    expiresInSeconds: 900,
    archiveBucket: "test-archives",
    archiveKey: "runs/test-plate-reader/run-1/abc.zip",
  }),
}));

vi.mock("@/lib/api/file-reprocessing", () => ({
  reprocessFile: vi.fn().mockImplementation((id: number) => {
    if (id === 42) {
      return { ok: true, fileId: id };
    }
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: `File '${id}' not found`,
    };
  }),
  reprocessRun: vi.fn().mockResolvedValue({
    ok: true,
    instrumentId: "test-plate-reader",
    runId: "run-1",
    filesQueued: 1,
    filesFailed: 0,
  }),
}));

vi.mock("@/lib/api/run-lifecycle", () => ({
  softDeleteRun: vi.fn().mockResolvedValue({
    ok: true,
    id: "internal-1",
    instrumentId: "test-plate-reader",
    runId: "run-1",
    deletedAt: new Date("2025-01-01"),
    deletedBy: "user-from-auth",
    alreadyApplied: false,
  }),
  restoreRun: vi.fn().mockResolvedValue({
    ok: true,
    id: "internal-1",
    instrumentId: "test-plate-reader",
    runId: "run-1",
    deletedAt: null,
    alreadyApplied: false,
  }),
}));

vi.mock("@/lib/api/run-uploads", () => ({
  requestRunUploads: vi.fn().mockResolvedValue({
    ok: true,
    instrumentId: "test-plate-reader",
    runId: "run-1",
    filesQueued: 1,
    files: [{ id: 1, filename: "a.txt", uploadRequestedAt: new Date() }],
  }),
  requestAllRunUploads: vi.fn().mockResolvedValue({
    ok: true,
    instrumentId: "test-plate-reader",
    runId: "run-1",
    filesQueued: 2,
  }),
}));

vi.mock("@/lib/api/run-comments", () => ({
  listCommentsForRun: vi.fn().mockResolvedValue([]),
  createComment: vi.fn().mockResolvedValue({
    id: "c-1",
    body: "hi",
    created_at: new Date(),
    edited_at: null,
    user: { id: "u-1", displayName: "Alice", initials: "A", avatarUrl: null },
  }),
  createCommentAndNotify: vi.fn().mockResolvedValue({
    id: "c-1",
    body: "hi",
    created_at: new Date(),
    edited_at: null,
    user: { id: "u-1", displayName: "Alice", initials: "A", avatarUrl: null },
  }),
  getCommentForAuthorCheck: vi.fn().mockResolvedValue(null),
  getCommentForDeleteAuthorCheck: vi.fn().mockResolvedValue(null),
  updateComment: vi.fn().mockResolvedValue(null),
  softDeleteComment: vi.fn().mockResolvedValue(false),
  validateCommentBody: vi.fn().mockImplementation((body: unknown) => {
    if (typeof body !== "string" || body.trim().length === 0) {
      return { ok: false, message: "body must not be empty" };
    }
    return { ok: true, body };
  }),
}));

vi.mock("@/lib/api/notifications", () => ({
  notifyComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/s3", () => ({
  getPresignedDownloadUrl: vi
    .fn()
    .mockResolvedValue("https://s3.example.com/signed-url"),
  // Mirror the real export so consumers (e.g. `tools.ts`) that import
  // it for the response payload see a numeric value instead of
  // `undefined`. Tests that read `expiresInSeconds` off a tool result
  // assert `> 0`, so any positive number works here.
  PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS: 15 * 60,
}));

// ---------------------------------------------------------------------------
// Now import the registration functions (they'll pick up the mocked deps).
// ---------------------------------------------------------------------------

import {
  buildMcpCatalogDocument,
  MCP_PROMPT_DEFS,
  MCP_RESOURCE_DEFS,
  MCP_TOOL_DEFS,
} from "@/lib/mcp/catalog";
import { MCP_SERVER_INSTRUCTIONS } from "@/lib/mcp/instructions";
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
      {
        capabilities: { tools: {}, resources: {}, prompts: {} },
        instructions: MCP_SERVER_INSTRUCTIONS,
      }
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

  const EXPECTED_TOOLS = MCP_TOOL_DEFS.map((t) => t.name);

  const WRITE_TOOLS = new Set([
    "reprocess_file",
    "claim_run",
    "claim_runs",
    "unclaim_run",
    "add_run_comment",
    "edit_run_comment",
    "delete_run_comment",
    "reprocess_run",
    "delete_run",
    "restore_run",
    "request_run_upload",
    "request_run_upload_all",
    "dismiss_file",
  ]);

  it("registers all expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...EXPECTED_TOOLS]));
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
  });

  it("registered tool names match the MCP catalog document", async () => {
    const { tools } = await client.listTools();
    const live = new Set(tools.map((t) => t.name));
    const catalog = new Set(MCP_TOOL_DEFS.map((t) => t.name));
    const document = new Set(
      buildMcpCatalogDocument().tools.map((t) => t.name)
    );
    expect(live).toEqual(catalog);
    expect(document).toEqual(catalog);
  });

  it("registered prompt names match the MCP catalog document", async () => {
    const { prompts } = await client.listPrompts();
    const live = new Set(prompts.map((p) => p.name));
    const catalog = new Set(MCP_PROMPT_DEFS.map((p) => p.name));
    const document = new Set(
      buildMcpCatalogDocument().prompts.map((p) => p.name)
    );
    expect(live).toEqual(catalog);
    expect(document).toEqual(catalog);
  });

  it("registered resource names match the MCP catalog document", async () => {
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    const document = buildMcpCatalogDocument();

    const catalogStatic = MCP_RESOURCE_DEFS.filter((r) => r.kind === "static");
    const catalogTemplates = MCP_RESOURCE_DEFS.filter(
      (r) => r.kind === "template"
    );

    const liveStaticNames = new Set(
      resources
        .filter((r) => catalogStatic.some((c) => c.uri === r.uri))
        .map((r) => r.name)
    );
    expect(liveStaticNames).toEqual(new Set(catalogStatic.map((r) => r.name)));
    expect(
      new Set(document.resources.filter((r) => r.uri).map((r) => r.name))
    ).toEqual(new Set(catalogStatic.map((r) => r.name)));

    const liveTemplateNames = new Set(resourceTemplates.map((r) => r.name));
    expect(liveTemplateNames).toEqual(
      new Set(catalogTemplates.map((r) => r.name))
    );
    expect(
      new Set(
        document.resources.filter((r) => r.uriTemplate).map((r) => r.name)
      )
    ).toEqual(new Set(catalogTemplates.map((r) => r.name)));
  });

  it("every tool has a non-empty description", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
    }
  });

  it("read-only tools are annotated as such; write tools are not", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (WRITE_TOOLS.has(tool.name)) {
        expect(
          tool.annotations?.readOnlyHint,
          `${tool.name} should not be read-only`
        ).toBe(false);
      } else {
        expect(
          tool.annotations?.readOnlyHint,
          `${tool.name} not read-only`
        ).toBe(true);
      }
    }
  });

  it("tools that require params declare them in inputSchema", async () => {
    const { tools } = await client.listTools();
    const getInstrument = tools.find((t) => t.name === "get_instrument");
    expect(getInstrument?.inputSchema.properties).toHaveProperty(
      "instrumentId"
    );

    const getRun = tools.find((t) => t.name === "get_run");
    expect(getRun?.inputSchema.properties).toHaveProperty("instrumentId");
    expect(getRun?.inputSchema.properties).toHaveProperty("runId");
    expect(getRun?.inputSchema.properties).toHaveProperty("include");

    const getFile = tools.find((t) => t.name === "get_file");
    expect(getFile?.inputSchema.properties).toHaveProperty("fileId");

    const reprocess = tools.find((t) => t.name === "reprocess_file");
    expect(reprocess?.inputSchema.properties).toHaveProperty("fileId");

    const heartbeats = tools.find((t) => t.name === "get_watcher_heartbeats");
    expect(heartbeats?.inputSchema.properties).toHaveProperty("watcherId");

    // Attribution tools intentionally do NOT expose a `userId` argument — the
    // authenticated user is pulled from `authInfo.extra.userId` on the server
    // so the wire API has no spoofable slot.
    const claimRun = tools.find((t) => t.name === "claim_run");
    expect(claimRun?.inputSchema.properties).toHaveProperty("instrumentId");
    expect(claimRun?.inputSchema.properties).toHaveProperty("runId");
    expect(claimRun?.inputSchema.properties).not.toHaveProperty("userId");

    const unclaimRun = tools.find((t) => t.name === "unclaim_run");
    expect(unclaimRun?.inputSchema.properties).toHaveProperty("instrumentId");
    expect(unclaimRun?.inputSchema.properties).toHaveProperty("runId");
    expect(unclaimRun?.inputSchema.properties).not.toHaveProperty("userId");

    const listAttributors = tools.find(
      (t) => t.name === "list_run_attributors"
    );
    expect(listAttributors?.inputSchema.properties).toHaveProperty(
      "instrumentId"
    );

    // search_runs gained a `ranBy` filter alongside the new attribution tools,
    // plus instrument-type metadata filters used by the UI run tables.
    const searchRuns = tools.find((t) => t.name === "search_runs");
    expect(searchRuns?.inputSchema.properties).toHaveProperty("ranBy");
    expect(searchRuns?.inputSchema.properties).toHaveProperty("captureType");
    expect(searchRuns?.inputSchema.properties).toHaveProperty("dyeChannel");
    expect(searchRuns?.inputSchema.properties).toHaveProperty("hinaChannel");
    expect(searchRuns?.inputSchema.properties).toHaveProperty("dpi");

    const globalSearch = tools.find((t) => t.name === "global_search");
    expect(globalSearch?.inputSchema.properties).toHaveProperty("query");
  });

  it("every registered tool advertises outputSchema", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(32);
    for (const tool of tools) {
      const schema = tool.outputSchema as
        | { type?: string; oneOf?: unknown; anyOf?: unknown }
        | undefined;
      expect(
        schema?.type != null || schema?.oneOf != null || schema?.anyOf != null,
        `${tool.name} missing outputSchema`
      ).toBe(true);
    }
  });

  it("catalog outputSchema matches tools/list", async () => {
    const doc = buildMcpCatalogDocument();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const catalog = doc.tools.find((t) => t.name === tool.name);
      expect(catalog?.outputSchema, `${tool.name} catalog mismatch`).toEqual(
        tool.outputSchema
      );
    }
  });

  it("claim_run is annotated as write / non-destructive / idempotent", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "claim_run");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(true);
  });

  it("claim_runs is annotated as write / non-destructive / idempotent", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "claim_runs");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(true);
  });

  it("unclaim_run is annotated as write / destructive / idempotent", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "unclaim_run");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?.annotations?.idempotentHint).toBe(true);
  });

  it("request_run_upload tools are annotated as write / non-destructive / idempotent", async () => {
    const { tools } = await client.listTools();
    for (const name of ["request_run_upload", "request_run_upload_all"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint, `${name} not read-only`).toBe(
        false
      );
      expect(
        tool?.annotations?.destructiveHint,
        `${name} non-destructive`
      ).toBe(false);
      expect(tool?.annotations?.idempotentHint, `${name} idempotent`).toBe(
        true
      );
    }
  });

  it("soft-delete / restore / dismiss tools are annotated idempotent", async () => {
    const { tools } = await client.listTools();
    for (const name of ["delete_run", "restore_run", "dismiss_file"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint, `${name} not read-only`).toBe(
        false
      );
      expect(tool?.annotations?.idempotentHint, `${name} idempotent`).toBe(
        true
      );
    }
  });

  // ---- Tool execution (happy path) ----------------------------------------

  function parseText(content: unknown): unknown {
    const text = (content as Array<{ type: string; text: string }>)[0]?.text;
    return JSON.parse(text ?? "");
  }

  function expectStructuredMatchesText(result: {
    content: unknown;
    structuredContent?: unknown;
  }) {
    // All tools return object roots so content text and structuredContent match.
    expect(result.structuredContent).toEqual(parseText(result.content));
  }

  it("list_instruments returns JSON text content", async () => {
    const result = await client.callTool({
      name: "list_instruments",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content) as {
      instruments: unknown[];
    };
    expect(parsed.instruments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "test-plate-reader" }),
      ])
    );
    expect(result.structuredContent).toEqual(parsed);
  });

  it("get_instrument returns instrument detail", async () => {
    const result = await client.callTool({
      name: "get_instrument",
      arguments: { instrumentId: "test-plate-reader" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content) as { id: string };
    expect(parsed.id).toBe("test-plate-reader");
    expect(result.structuredContent).toEqual(parsed);
  });

  it("search_runs returns paginated results", async () => {
    const result = await client.callTool({
      name: "search_runs",
      arguments: { page: 1, perPage: 10 },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content);
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("pagination");
    expectStructuredMatchesText(result);
  });

  it("search_runs rejects invalid metadata filters with allowed values", async () => {
    const result = await client.callTool({
      name: "search_runs",
      arguments: {
        instrumentId: "test-plate-reader",
        wavelength: "999",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      ?.text;
    expect(text).toContain("Invalid wavelength");
    expect(text).toContain("450");
    expect(text).toContain("filter-options");
  });

  it("search_runs forwards gel-doc and qPCR metadata filters", async () => {
    const { buildRunListQuery } = await import("@/lib/api/instrument-runs");
    await client.callTool({
      name: "search_runs",
      arguments: {
        captureType: "Chemi",
        gelWavelength: "520",
        dyeChannel: "SYBR",
      },
    });
    expect(buildRunListQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        captureType: "Chemi",
        gelWavelength: "520",
        dyeChannel: "SYBR",
      })
    );
  });

  it('search_runs rejects ranBy="me" without auth', async () => {
    const result = await client.callTool({
      name: "search_runs",
      arguments: { ranBy: "me" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      ?.text;
    expect(text).toContain('ranBy="me"');
  });

  it("global_search returns grouped results", async () => {
    const result = await client.callTool({
      name: "global_search",
      arguments: { query: "plate" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content) as {
      counts: { total: number };
    };
    expect(parsed).toHaveProperty("runs");
    expect(parsed).toHaveProperty("files");
    expect(parsed).toHaveProperty("instruments");
    expect(parsed).toHaveProperty("users");
    expect(parsed).toHaveProperty("comments");
    expect(parsed.counts).toHaveProperty("total");
    expect(result.structuredContent).toEqual(parsed);
  });

  it("global_search rejects short queries", async () => {
    const result = await client.callTool({
      name: "global_search",
      arguments: { query: "a" },
    });
    expect(result.isError).toBe(true);
  });

  it("get_me errors without auth on the in-memory transport", async () => {
    const result = await client.callTool({
      name: "get_me",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("get_system_status returns data", async () => {
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
  });

  it("list_watchers returns data", async () => {
    const result = await client.callTool({
      name: "list_watchers",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as {
      watchers: Array<{ id: string }>;
    };
    expect(parsed.watchers).toEqual([
      expect.objectContaining({ id: "watcher-1", effectiveStatus: "watching" }),
    ]);
  });

  it("get_watcher returns watcher detail", async () => {
    const result = await client.callTool({
      name: "get_watcher",
      arguments: { watcherId: "watcher-1" },
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as {
      id: string;
      configYaml: string | null;
    };
    expect(parsed.id).toBe("watcher-1");
    expect(parsed.configYaml).toContain("watch:");
  });

  it("list_watcher_events returns paginated events", async () => {
    const result = await client.callTool({
      name: "list_watcher_events",
      arguments: { watcherId: "watcher-1", hours: 6 },
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as {
      watcherId: string;
      lookbackHours: number;
      total: number;
      rows: unknown[];
    };
    expect(parsed.watcherId).toBe("watcher-1");
    expect(parsed.lookbackHours).toBe(6);
    expect(parsed.total).toBe(1);
    expect(parsed.rows).toHaveLength(1);
  });

  it("get_file returns the file record", async () => {
    const result = await client.callTool({
      name: "get_file",
      arguments: { fileId: 42 },
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as { id: number };
    expect(parsed.id).toBe(42);
  });

  it("get_file_download_url returns a presigned URL", async () => {
    const result = await client.callTool({
      name: "get_file_download_url",
      arguments: { fileId: 42 },
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as {
      fileId: number;
      filename: string;
      downloadUrl: string;
      expiresInSeconds: number;
    };
    expect(parsed.fileId).toBe(42);
    expect(parsed.downloadUrl).toContain("s3.example.com");
    expect(parsed.expiresInSeconds).toBeGreaterThan(0);
  });

  it("get_run_archive returns a presigned URL on cache hit", async () => {
    const result = await client.callTool({
      name: "get_run_archive",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as {
      status: string;
      downloadUrl?: string;
      filename?: string;
      sizeBytes?: number;
      expiresInSeconds?: number;
      contentType?: string;
    };
    expect(parsed.status).toBe("ready");
    expect(parsed.downloadUrl).toContain("s3.example.com");
    expect(parsed.filename).toBe("run-1.zip");
    expect(parsed.expiresInSeconds).toBe(900);
    expect(parsed.contentType).toBe("application/zip");
  });

  it("get_run_archive returns a job and retry hint while building", async () => {
    const { prepareRunArchive } = await import("@/lib/api/run-archive");
    vi.mocked(prepareRunArchive).mockResolvedValueOnce({
      ok: true,
      status: "building",
      jobId: "job-abc",
      ownsBuild: true,
      retryAfterSeconds: 5,
    });

    const result = await client.callTool({
      name: "get_run_archive",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as {
      status: string;
      jobId?: string;
      retryAfterSeconds?: number;
      hint?: string;
    };
    expect(parsed.status).toBe("building");
    expect(parsed.jobId).toBe("job-abc");
    expect(parsed.retryAfterSeconds).toBe(5);
    expect(parsed.hint).toMatch(/get_run_archive/);
  });

  it("get_run_archive surfaces a clear error when no files are downloadable", async () => {
    const { prepareRunArchive } = await import("@/lib/api/run-archive");
    vi.mocked(prepareRunArchive).mockResolvedValueOnce({
      ok: false,
      status: 404,
      message: "No downloadable files for this run",
    });

    const result = await client.callTool({
      name: "get_run_archive",
      arguments: { instrumentId: "test-plate-reader", runId: "run-empty" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "No downloadable files for this run" },
    ]);
    expect(result.structuredContent).toBeUndefined();
  });

  it("reprocess_file succeeds for a reprocessable file", async () => {
    const result = await client.callTool({
      name: "reprocess_file",
      arguments: { fileId: 42 },
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as {
      status: string;
      fileId: number;
    };
    expect(parsed.status).toBe("processing");
    expect(parsed.fileId).toBe(42);
  });

  it("dismiss_file returns the soft-deleted file", async () => {
    const result = await client.callTool({
      name: "dismiss_file",
      arguments: { fileId: 1 },
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as {
      id: number;
      filename: string;
      alreadyApplied: boolean;
    };
    expect(parsed.id).toBe(1);
    expect(parsed.filename).toBe("a.txt");
    expect(parsed.alreadyApplied).toBe(false);
  });

  it("get_watcher_heartbeats returns heartbeat history", async () => {
    const result = await client.callTool({
      name: "get_watcher_heartbeats",
      arguments: { watcherId: "watcher-1", hours: 12 },
    });
    expect(result.isError).toBeFalsy();
    expectStructuredMatchesText(result);
    const parsed = parseText(result.content) as {
      watcherId: string;
      sinceIso: string;
      lookbackHours: number;
      total: number;
      heartbeats: unknown[];
    };
    expect(parsed.watcherId).toBe("watcher-1");
    expect(parsed.lookbackHours).toBe(12);
    expect(parsed.total).toBe(1);
    expect(parsed.heartbeats).toHaveLength(1);
    expect(parsed.sinceIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
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
      ?.text;
    expect(text).toContain("not found");
  });

  it("get_run include=failure_summary attaches summary", async () => {
    const { getRunFailureSummary } = await import("@/lib/api/run-reports");
    const result = await client.callTool({
      name: "get_run",
      arguments: {
        instrumentId: "test-plate-reader",
        runId: "run-1",
        include: ["failure_summary"],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(getRunFailureSummary).toHaveBeenCalled();
    const parsed = parseText(result.content) as {
      failureSummary: { totalFiles: number };
    };
    expect(parsed.failureSummary).toHaveProperty("totalFiles");
    expectStructuredMatchesText(result);
  });

  it("get_run_report returns bounded processed CSV sample", async () => {
    const result = await client.callTool({
      name: "get_run_report",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content) as {
      processedCsv: { sampleRowLimit: number };
    };
    expect(parsed.processedCsv.sampleRowLimit).toBe(20);
    expect(parsed).not.toHaveProperty("ok");
    expectStructuredMatchesText(result);
  });

  it("list_run_files returns error for nonexistent run", async () => {
    const result = await client.callTool({
      name: "list_run_files",
      arguments: { instrumentId: "test-plate-reader", runId: "nonexistent" },
    });
    expect(result.isError).toBe(true);
  });

  it("list_run_files returns a paginated payload and forwards page args", async () => {
    const { getRunFilesPage } = await import("@/lib/api/instrument-runs");
    vi.mocked(getRunFilesPage).mockResolvedValueOnce({
      data: [
        {
          id: 1,
          filename: "data.csv",
          relativePath: "data.csv",
          category: "raw",
          status: "uploaded",
          sizeBytes: 42,
          contentType: "text/csv",
          errorMessage: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          uploadedAt: new Date("2026-01-01T00:00:00Z"),
          processedAt: null,
          // Fields below should be stripped from the MCP payload.
          s3Bucket: "secret-bucket",
          s3Key: "secret/key",
          metadata: { huge: "blob" },
        } as never,
      ],
      pagination: { page: 2, per_page: 10, total: 25, total_pages: 3 },
    });

    const result = await client.callTool({
      name: "list_run_files",
      arguments: {
        instrumentId: "test-plate-reader",
        runId: "run-1",
        page: 2,
        perPage: 10,
        status: ["detected", "upload_requested"],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(getRunFilesPage).toHaveBeenCalledWith(MOCK_RUN_UUID_1, {
      page: 2,
      perPage: 10,
      statuses: ["detected", "upload_requested"],
    });
    const payload = parseText(result.content) as {
      data: Record<string, unknown>[];
      pagination: Record<string, unknown>;
    };
    expect(payload.pagination).toEqual({
      page: 2,
      per_page: 10,
      total: 25,
      total_pages: 3,
    });
    expect(payload.data[0]).not.toHaveProperty("s3Bucket");
    expect(payload.data[0]).not.toHaveProperty("s3Key");
    expect(payload.data[0]).not.toHaveProperty("metadata");
    expect(payload.data[0].filename).toBe("data.csv");
    expectStructuredMatchesText(result);
  });

  it("get_file returns error for nonexistent file", async () => {
    const result = await client.callTool({
      name: "get_file",
      arguments: { fileId: 999 },
    });
    expect(result.isError).toBe(true);
  });

  it("get_file_download_url returns error for unuploaded file", async () => {
    const result = await client.callTool({
      name: "get_file_download_url",
      arguments: { fileId: 99 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("not been uploaded");
  });

  it("reprocess_file returns error when the core helper reports failure", async () => {
    const result = await client.callTool({
      name: "reprocess_file",
      arguments: { fileId: 123 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("not found");
    // The error payload prefixes the structured code so clients can branch
    // on NOT_FOUND vs CONFLICT vs INTERNAL_ERROR without parsing the message.
    expect(text).toContain("[NOT_FOUND]");
  });

  it("reprocess_file is annotated as destructive", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "reprocess_file");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it("list_run_attributors returns the mocked list", async () => {
    const result = await client.callTool({
      name: "list_run_attributors",
      arguments: { instrumentId: "test-plate-reader" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content) as {
      attributors: Array<{ userId: string; displayName: string }>;
    };
    expect(parsed).toEqual({
      attributors: [{ userId: "u-1", displayName: "Alice" }],
    });
    expectStructuredMatchesText(result);
  });

  it("list_run_comments returns structured comments payload", async () => {
    const result = await client.callTool({
      name: "list_run_comments",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content) as { comments: unknown[] };
    expect(parsed).toEqual({ comments: [] });
    expectStructuredMatchesText(result);
  });

  it("reprocess_run returns structured queue counts", async () => {
    const result = await client.callTool({
      name: "reprocess_run",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result.content) as {
      instrumentId: string;
      filesQueued: number;
      filesFailed: number;
    };
    expect(parsed.instrumentId).toBe("test-plate-reader");
    expect(parsed.filesQueued).toBe(1);
    expect(parsed.filesFailed).toBe(0);
    expectStructuredMatchesText(result);
  });

  it("delete_run and restore_run return structured lifecycle payloads", async () => {
    const deleted = await client.callTool({
      name: "delete_run",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(deleted.isError).toBeFalsy();
    const deletedPayload = parseText(deleted.content) as {
      alreadyApplied: boolean;
      deletedAt: string;
    };
    expect(deletedPayload.alreadyApplied).toBe(false);
    expect(deletedPayload.deletedAt).toBeTruthy();
    expectStructuredMatchesText(deleted);

    const restored = await client.callTool({
      name: "restore_run",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(restored.isError).toBeFalsy();
    const restoredPayload = parseText(restored.content) as {
      deletedAt: null;
      alreadyApplied: boolean;
    };
    expect(restoredPayload.deletedAt).toBeNull();
    expect(restoredPayload.alreadyApplied).toBe(false);
    expectStructuredMatchesText(restored);
  });

  it("request_run_upload tools return structured queue payloads", async () => {
    const one = await client.callTool({
      name: "request_run_upload",
      arguments: {
        instrumentId: "test-plate-reader",
        runId: "run-1",
        fileIds: [1],
      },
    });
    expect(one.isError).toBeFalsy();
    const onePayload = parseText(one.content) as {
      filesQueued: number;
      files: Array<{ id: number; filename: string }>;
    };
    expect(onePayload.filesQueued).toBe(1);
    expect(onePayload.files).toEqual([
      expect.objectContaining({ id: 1, filename: "a.txt" }),
    ]);
    expectStructuredMatchesText(one);

    const all = await client.callTool({
      name: "request_run_upload_all",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(all.isError).toBeFalsy();
    const allPayload = parseText(all.content) as { filesQueued: number };
    expect(allPayload.filesQueued).toBe(2);
    expectStructuredMatchesText(all);
  });

  it("comment mutation tools require authInfo on the in-memory transport", async () => {
    for (const call of [
      {
        name: "add_run_comment",
        arguments: {
          instrumentId: "test-plate-reader",
          runId: "run-1",
          body: "hi",
        },
      },
      {
        name: "edit_run_comment",
        arguments: { commentId: "c-1", body: "edited" },
      },
      {
        name: "delete_run_comment",
        arguments: { commentId: "c-1" },
      },
    ] as const) {
      const result = await client.callTool(call);
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain("Authenticated user not available");
      expect(result.structuredContent).toBeUndefined();
    }
  });

  // The in-memory transport does not supply `authInfo`, so the tool must
  // refuse to attribute anything. The happy path lives in the HTTP suite
  // where a real Bearer token resolves `authInfo.extra.userId`.
  it("claim_run without authInfo reports an authenticated-user error", async () => {
    const result = await client.callTool({
      name: "claim_run",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Authenticated user not available");
  });

  it("claim_runs without authInfo reports an authenticated-user error", async () => {
    const result = await client.callTool({
      name: "claim_runs",
      arguments: {
        instrumentId: "test-plate-reader",
        runIds: ["run-1", "missing"],
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Authenticated user not available");
  });

  it("unclaim_run without authInfo reports an authenticated-user error", async () => {
    const result = await client.callTool({
      name: "unclaim_run",
      arguments: { instrumentId: "test-plate-reader", runId: "run-1" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("Authenticated user not available");
  });

  it("get_instrument_filter_options returns plate-reader options", async () => {
    const result = await client.callTool({
      name: "get_instrument_filter_options",
      arguments: { instrumentId: "test-plate-reader" },
    });
    expect(result.isError).toBeFalsy();
    const payload = parseText(result.content) as {
      instrumentId: string;
      options: { wavelengths: string[] };
    };
    expect(payload.instrumentId).toBe("test-plate-reader");
    expect(payload.options.wavelengths).toContain("450");
    expect(result.structuredContent).toEqual(payload);
  });

  it("get_instrument_filter_options errors for unknown instruments", async () => {
    const result = await client.callTool({
      name: "get_instrument_filter_options",
      arguments: { instrumentId: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("not found");
  });

  // ---- Resources -----------------------------------------------------------

  it("lists resources including instruments, me, and glossary", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("datahub://instruments");
    expect(uris).toContain("datahub://me");
    expect(uris).toContain("datahub://glossary");
  });

  it("reads the glossary resource", async () => {
    const { contents } = await client.readResource({
      uri: "datahub://glossary",
    });
    const parsed = JSON.parse(
      (contents[0] as { uri: string; text: string }).text
    );
    expect(parsed).toHaveProperty("runStatus");
    expect(parsed).toHaveProperty("dates");
    expect(parsed).not.toHaveProperty("toolRouting");
  });

  it("exposes server instructions after initialize", () => {
    expect(client.getInstructions()).toBe(MCP_SERVER_INSTRUCTIONS);
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

  it("lists resource templates for filter options", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(
      resourceTemplates.some((t) => t.uriTemplate.includes("filter-options"))
    ).toBe(true);
  });

  it("filter-options list surfaces both plate-reader and gel-doc instruments", async () => {
    const { resources } = await client.listResources();
    const filterOptionUris = resources
      .map((r) => r.uri)
      .filter((uri) => uri.includes("/filter-options"));
    expect(
      filterOptionUris.some((uri) => uri.includes("test-plate-reader"))
    ).toBe(true);
    expect(filterOptionUris.some((uri) => uri.includes("test-gel-doc"))).toBe(
      true
    );
  });

  it("reads plate-reader filter options", async () => {
    const { contents } = await client.readResource({
      uri: "datahub://instruments/test-plate-reader/filter-options",
    });
    const parsed = JSON.parse(
      (contents[0] as { uri: string; text: string }).text
    );
    expect(parsed).toHaveProperty("wavelengths");
    expect(parsed).toHaveProperty("measurementModes");
  });

  it("reads gel-doc filter options", async () => {
    const { contents } = await client.readResource({
      uri: "datahub://instruments/test-gel-doc/filter-options",
    });
    const parsed = JSON.parse(
      (contents[0] as { uri: string; text: string }).text
    );
    expect(parsed).toHaveProperty("captureTypes");
    expect(parsed).toHaveProperty("colors");
  });

  it("filter-options read surfaces a structured error for unfilterable instrument types", async () => {
    // MOCK_GENERIC_INSTRUMENT exists in getInstrumentById but has an
    // instrumentType ('generic') that's not in FILTERABLE_INSTRUMENT_TYPES.
    // The resource template should respond with an explanatory error object.
    const { contents } = await client.readResource({
      uri: "datahub://instruments/test-generic/filter-options",
    });
    const parsed = JSON.parse(
      (contents[0] as { uri: string; text: string }).text
    );
    expect(parsed).toHaveProperty("error");
    expect(String(parsed.error)).toContain("generic");
  });

  it("filter-options read surfaces a not-found error for unknown instrument IDs", async () => {
    const { contents } = await client.readResource({
      uri: "datahub://instruments/does-not-exist/filter-options",
    });
    const parsed = JSON.parse(
      (contents[0] as { uri: string; text: string }).text
    );
    expect(parsed).toHaveProperty("error");
    expect(String(parsed.error)).toContain("not found");
  });

  // ---- Prompts -------------------------------------------------------------

  const EXPECTED_PROMPTS = MCP_PROMPT_DEFS.map((p) => p.name);

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
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("2025-06-01 (UTC)");
  });

  it("troubleshoot_instrument prompt references heartbeat tool", async () => {
    const result = await client.getPrompt({
      name: "troubleshoot_instrument",
      arguments: { instrumentId: "my-inst" },
    });
    expect(result.messages).toHaveLength(1);
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("my-inst");
    expect(text).toContain("get_watcher_heartbeats");
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

  it("claim_unattributed_runs prompt uses claim_runs", async () => {
    const result = await client.getPrompt({
      name: "claim_unattributed_runs",
      arguments: { instrumentId: "my-inst" },
    });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("claim_runs");
  });

  it("completes instrumentId on troubleshoot_instrument", async () => {
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "troubleshoot_instrument" },
      argument: { name: "instrumentId", value: "test-" },
    });
    expect(result.completion.values).toContain("test-plate-reader");
  });

  it("completes optional instrumentId on find_my_runs", async () => {
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "find_my_runs" },
      argument: { name: "instrumentId", value: "test-" },
    });
    expect(result.completion.values).toContain("test-plate-reader");
  });

  it("completes runId on compare_runs using instrument context", async () => {
    const { buildRunListQuery } = await import("@/lib/api/instrument-runs");
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "compare_runs" },
      argument: { name: "runId1", value: "run-" },
      context: { arguments: { instrumentId: "test-plate-reader" } },
    });
    expect(buildRunListQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentId: "test-plate-reader",
        search: "run-",
        perPage: 100,
      })
    );
    expect(result.completion.values).toEqual(
      expect.arrayContaining(["run-1", "run-2"])
    );
  });

  it("completes instrumentId on the filter-options resource template", async () => {
    const result = await client.complete({
      ref: {
        type: "ref/resource",
        uri: "datahub://instruments/{instrumentId}/filter-options",
      },
      argument: { name: "instrumentId", value: "test-" },
    });
    expect(result.completion.values).toContain("test-plate-reader");
  });
});
