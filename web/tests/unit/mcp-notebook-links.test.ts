import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The notebook link tools act as the signed-in user, taken from the session.
// These tests replace the run lookup and the writes, so they check only what
// each tool passes on: who the actor is, the runs, and how a label is read.

const {
  lookupRunByNaturalKey,
  bulkAddNotebookLink,
  bulkRemoveNotebookLinks,
  updateNotebookLink,
} = vi.hoisted(() => ({
  lookupRunByNaturalKey: vi.fn(),
  bulkAddNotebookLink: vi.fn(),
  bulkRemoveNotebookLinks: vi.fn(),
  updateNotebookLink: vi.fn(),
}));

vi.mock("@/lib/api/instrument-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/instrument-runs")>()),
  lookupRunByNaturalKey,
}));
vi.mock("@/lib/api/run-notebook-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/run-notebook-links")>()),
  bulkAddNotebookLink,
  bulkRemoveNotebookLinks,
  updateNotebookLink,
}));

import { registerNotebookLinkTools } from "@/lib/mcp/tools/notebook-links";

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { http: { authInfo: AuthInfo } }
) => Promise<{
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: unknown;
}>;

function tool(name: string): ToolHandler {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (
      toolName: string,
      _config: unknown,
      handler: ToolHandler
    ) => {
      tools.set(toolName, handler);
    },
  };
  registerNotebookLinkTools(server as unknown as McpServer);
  const handler = tools.get(name);
  if (!handler) {
    throw new Error(`${name} is not registered`);
  }
  return handler;
}

function ctxWith(scopes: string[]) {
  return {
    http: {
      authInfo: {
        token: "token",
        clientId: "client-1",
        scopes,
        extra: { userId: "user-1" },
      },
    },
  };
}

const writeCtx = ctxWith(["read", "write"]);

const LINK = {
  id: "9b2c4e1a-7d3f-4a5b-8c6d-0e1f2a3b4c5d",
  runId: "run-uuid",
  url: "https://example.com/eln/4",
  urlKey: "example.com/eln/4",
  label: null,
  displayName: "example.com › 4",
  createdAt: new Date("2026-11-13T00:00:00.000Z"),
  createdBy: null,
  updatedAt: new Date("2026-11-13T00:00:00.000Z"),
  updatedBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  lookupRunByNaturalKey.mockResolvedValue({ id: "run-uuid", runId: "RUN1" });
  bulkAddNotebookLink.mockResolvedValue({
    ok: true,
    value: {
      url: LINK.url,
      urlKey: LINK.urlKey,
      results: [
        { instrumentId: "inst", runId: "RUN1", outcome: "added", link: LINK },
      ],
    },
  });
  bulkRemoveNotebookLinks.mockResolvedValue({
    ok: true,
    value: {
      urlKeys: [LINK.urlKey],
      results: [
        { instrumentId: "inst", runId: "RUN1", outcome: "removed", removed: 1 },
      ],
    },
  });
  updateNotebookLink.mockResolvedValue({ ok: true, value: LINK });
});

describe("add_notebook_link", () => {
  it("adds the link as the signed-in user, never as an argument", async () => {
    const result = await tool("add_notebook_link")(
      {
        instrumentId: "inst",
        runIds: ["RUN1"],
        url: LINK.url,
        label: "",
        userId: "someone-else",
      },
      writeCtx
    );

    expect(result.isError).toBeFalsy();
    expect(bulkAddNotebookLink).toHaveBeenCalledWith({
      runs: [{ instrumentId: "inst", runId: "RUN1" }],
      url: LINK.url,
      label: null,
      actor: { kind: "user", userId: "user-1" },
    });
    expect(result.structuredContent).toMatchObject({
      counts: { added: 1, already_linked: 0 },
      results: [{ runId: "RUN1", outcome: "added" }],
    });
  });

  it("refuses a session without the write scope", async () => {
    const result = await tool("add_notebook_link")(
      { instrumentId: "inst", runIds: ["RUN1"], url: LINK.url },
      ctxWith(["read"])
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/write/);
    expect(bulkAddNotebookLink).not.toHaveBeenCalled();
  });
});

describe("update_notebook_link", () => {
  it("clears the label when label is null and keeps the URL when it's left out", async () => {
    await tool("update_notebook_link")(
      { instrumentId: "inst", runId: "RUN1", linkId: LINK.id, label: null },
      writeCtx
    );

    expect(updateNotebookLink).toHaveBeenCalledWith({
      runInternalId: "run-uuid",
      linkId: LINK.id,
      url: undefined,
      label: null,
      actor: { kind: "user", userId: "user-1" },
    });
  });

  it("keeps the label when label is left out", async () => {
    await tool("update_notebook_link")(
      {
        instrumentId: "inst",
        runId: "RUN1",
        linkId: LINK.id,
        url: "https://example.com/eln/5",
      },
      writeCtx
    );

    expect(updateNotebookLink).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/eln/5",
        label: undefined,
      })
    );
  });

  it("reports the existing link when the new URL is a duplicate", async () => {
    updateNotebookLink.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "This run already has a link to that page",
      details: { link_id: "other-link" },
    });

    const result = await tool("update_notebook_link")(
      {
        instrumentId: "inst",
        runId: "RUN1",
        linkId: LINK.id,
        url: "https://example.com/eln/5",
      },
      writeCtx
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "This run already has a link to that page (link other-link)."
    );
  });
});

describe("remove_notebook_link", () => {
  it("removes the page from every named run", async () => {
    const result = await tool("remove_notebook_link")(
      { instrumentId: "inst", runIds: ["RUN1", "RUN2"], url: LINK.url },
      writeCtx
    );

    expect(bulkRemoveNotebookLinks).toHaveBeenCalledWith({
      runs: [
        { instrumentId: "inst", runId: "RUN1" },
        { instrumentId: "inst", runId: "RUN2" },
      ],
      urls: [LINK.url],
    });
    expect(result.structuredContent).toMatchObject({
      urlKey: LINK.urlKey,
      counts: { removed: 1 },
    });
  });
});
