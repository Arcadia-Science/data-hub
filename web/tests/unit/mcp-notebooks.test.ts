import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookDto } from "@/lib/api/notebooks";

// The notebook tools act as the signed-in user, taken from the session.
// These tests replace the service, so they check only what each tool passes
// on: who the actor is, the owner, the runs, and how blanks and nulls are
// read. The integration suite covers the real writes.

const {
  listNotebooks,
  getNotebook,
  createNotebook,
  updateNotebook,
  deleteNotebook,
  restoreNotebook,
  addRunsToNotebook,
  removeRunsFromNotebook,
} = vi.hoisted(() => ({
  listNotebooks: vi.fn(),
  getNotebook: vi.fn(),
  createNotebook: vi.fn(),
  updateNotebook: vi.fn(),
  deleteNotebook: vi.fn(),
  restoreNotebook: vi.fn(),
  addRunsToNotebook: vi.fn(),
  removeRunsFromNotebook: vi.fn(),
}));

vi.mock("@/lib/api/notebooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/notebooks")>()),
  listNotebooks,
  getNotebook,
  createNotebook,
  updateNotebook,
  deleteNotebook,
  restoreNotebook,
  addRunsToNotebook,
  removeRunsFromNotebook,
}));

import { registerNotebookTools } from "@/lib/mcp/tools/notebooks";

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
  registerNotebookTools(server as unknown as McpServer);
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

const readCtx = ctxWith(["read"]);
const writeCtx = ctxWith(["read", "write"]);
const ACTOR = { kind: "user", userId: "user-1" };

const NOTEBOOK_ID = "9b2c4e1a-7d3f-4a5b-8c6d-0e1f2a3b4c5d";
const OTHER_ID = "4f6a8c0e-2b4d-4f6a-9c0e-2b4d6f8a0c2e";

const NOTEBOOK: NotebookDto = {
  id: NOTEBOOK_ID,
  url: "https://example.com/eln/4",
  urlKey: "example.com/eln/4",
  name: "Heat stress",
  description: null,
  owner: null,
  runCount: 1,
  instrumentCount: 1,
  lastRunAt: new Date("2026-11-13T00:00:00.000Z"),
  createdAt: new Date("2026-11-13T00:00:00.000Z"),
  createdBy: null,
  updatedAt: new Date("2026-11-13T00:00:00.000Z"),
  updatedBy: null,
  deletedAt: null,
  deletedBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  listNotebooks.mockResolvedValue({
    notebooks: [NOTEBOOK],
    total: 45,
    page: 2,
    perPage: 20,
  });
  getNotebook.mockResolvedValue(NOTEBOOK);
  createNotebook.mockResolvedValue({
    ok: true,
    value: { notebook: NOTEBOOK, runs: null },
  });
  updateNotebook.mockResolvedValue({ ok: true, value: NOTEBOOK });
  deleteNotebook.mockResolvedValue({
    ok: true,
    value: { ...NOTEBOOK, deletedAt: new Date("2026-11-14T00:00:00.000Z") },
  });
  restoreNotebook.mockResolvedValue({ ok: true, value: NOTEBOOK });
  addRunsToNotebook.mockResolvedValue({
    ok: true,
    value: {
      notebookId: NOTEBOOK_ID,
      results: [
        { instrumentId: "inst", runId: "RUN1", outcome: "added" },
        { instrumentId: "inst", runId: "RUN2", outcome: "not_found" },
      ],
    },
  });
  removeRunsFromNotebook.mockResolvedValue({
    ok: true,
    value: {
      notebookId: NOTEBOOK_ID,
      results: [{ instrumentId: "inst", runId: "RUN1", outcome: "removed" }],
    },
  });
});

describe("list_lab_notebooks", () => {
  it("lists lab notebooks without write access, with a page of 20 by default", async () => {
    const result = await tool("list_lab_notebooks")({ query: "heat" }, readCtx);

    expect(result.isError).toBeFalsy();
    expect(listNotebooks).toHaveBeenCalledWith({
      query: "heat",
      ownerId: undefined,
      includeDeleted: false,
      sort: undefined,
      order: undefined,
      page: 1,
      perPage: 20,
    });
    expect(result.structuredContent).toMatchObject({
      data: [
        { id: NOTEBOOK_ID, name: "Heat stress", url_key: NOTEBOOK.urlKey },
      ],
      pagination: { page: 2, per_page: 20, total: 45, total_pages: 3 },
    });
  });

  it('reads ownerId "me" as the signed-in user', async () => {
    await tool("list_lab_notebooks")({ ownerId: "me" }, readCtx);

    expect(listNotebooks).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "user-1" })
    );
  });
});

describe("get_lab_notebook", () => {
  it("says when there is no lab notebook with that id", async () => {
    getNotebook.mockResolvedValueOnce(null);

    const result = await tool("get_lab_notebook")(
      { labNotebookId: OTHER_ID },
      readCtx
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`Notebook '${OTHER_ID}' not found.`);
  });
});

describe("create_lab_notebook", () => {
  it("creates as the signed-in user, never as an argument, and leaves the owner empty", async () => {
    const result = await tool("create_lab_notebook")(
      {
        url: NOTEBOOK.url,
        name: "Heat stress",
        description: "",
        userId: "someone-else",
      },
      writeCtx
    );

    expect(result.isError).toBeFalsy();
    expect(createNotebook).toHaveBeenCalledWith({
      url: NOTEBOOK.url,
      name: "Heat stress",
      description: null,
      ownerId: null,
      runs: undefined,
      actor: ACTOR,
    });
    expect(result.structuredContent).toMatchObject({
      labNotebook: { id: NOTEBOOK_ID },
      runs: null,
    });
  });

  it('adds the given runs, and reads ownerId "me" as the signed-in user', async () => {
    createNotebook.mockResolvedValueOnce({
      ok: true,
      value: {
        notebook: NOTEBOOK,
        runs: {
          notebookId: NOTEBOOK_ID,
          results: [{ instrumentId: "inst", runId: "RUN1", outcome: "added" }],
        },
      },
    });

    const result = await tool("create_lab_notebook")(
      {
        url: NOTEBOOK.url,
        name: "Heat stress",
        ownerId: "me",
        instrumentId: "inst",
        runIds: ["RUN1"],
      },
      writeCtx
    );

    expect(createNotebook).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-1",
        runs: [{ instrumentId: "inst", runId: "RUN1" }],
      })
    );
    expect(result.structuredContent).toMatchObject({
      runs: {
        labNotebookId: NOTEBOOK_ID,
        instrumentId: "inst",
        results: [{ runId: "RUN1", outcome: "added" }],
        counts: { added: 1, already_in_lab_notebook: 0, not_found: 0 },
      },
    });
  });

  it("refuses runIds without an instrument", async () => {
    const result = await tool("create_lab_notebook")(
      { url: NOTEBOOK.url, name: "Heat stress", runIds: ["RUN1"] },
      writeCtx
    );

    expect(result.isError).toBe(true);
    expect(createNotebook).not.toHaveBeenCalled();
  });

  it("refuses a session without the write scope", async () => {
    const result = await tool("create_lab_notebook")(
      { url: NOTEBOOK.url, name: "Heat stress" },
      readCtx
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/write/);
    expect(createNotebook).not.toHaveBeenCalled();
  });

  it("names the lab notebook that already has the page and how to add runs to it", async () => {
    createNotebook.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: 'The lab notebook "Heat stress" already has this page.',
      details: { lab_notebook_id: OTHER_ID, deleted: false },
    });

    const result = await tool("create_lab_notebook")(
      { url: NOTEBOOK.url, name: "Heat stress, again" },
      writeCtx
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `The lab notebook "Heat stress" already has this page. Lab notebook id: ${OTHER_ID}. Add runs to it with add_runs_to_lab_notebook.`
    );
  });

  it("says to restore a deleted lab notebook that already has the page", async () => {
    createNotebook.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message:
        'The deleted lab notebook "Heat stress" already has this page. Restore it instead.',
      details: { lab_notebook_id: OTHER_ID, deleted: true },
    });

    const result = await tool("create_lab_notebook")(
      { url: NOTEBOOK.url, name: "Heat stress" },
      writeCtx
    );

    expect(result.content[0].text).toContain(`Lab notebook id: ${OTHER_ID}.`);
    expect(result.content[0].text).toContain(
      "Call restore_lab_notebook, then add_runs_to_lab_notebook."
    );
  });
});

describe("update_lab_notebook", () => {
  it("clears the description and owner when they are null, and keeps what is left out", async () => {
    await tool("update_lab_notebook")(
      { labNotebookId: NOTEBOOK_ID, description: null, ownerId: null },
      writeCtx
    );

    expect(updateNotebook).toHaveBeenCalledWith({
      id: NOTEBOOK_ID,
      name: undefined,
      description: null,
      ownerId: null,
      url: undefined,
      actor: ACTOR,
    });
  });

  it('reads a blank description as none and ownerId "me" as the signed-in user', async () => {
    await tool("update_lab_notebook")(
      { labNotebookId: NOTEBOOK_ID, description: "", ownerId: "me" },
      writeCtx
    );

    expect(updateNotebook).toHaveBeenCalledWith(
      expect.objectContaining({ description: null, ownerId: "user-1" })
    );
  });

  it("asks for a change when every field is left out", async () => {
    const result = await tool("update_lab_notebook")(
      { labNotebookId: NOTEBOOK_ID },
      writeCtx
    );

    expect(result.isError).toBe(true);
    expect(updateNotebook).not.toHaveBeenCalled();
  });

  it("names the lab notebook that already has the new page", async () => {
    updateNotebook.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: 'The lab notebook "Yeast growth" already has this page.',
      details: { lab_notebook_id: OTHER_ID, deleted: false },
    });

    const result = await tool("update_lab_notebook")(
      { labNotebookId: NOTEBOOK_ID, url: "https://example.com/eln/5" },
      writeCtx
    );

    expect(result.content[0].text).toBe(
      `The lab notebook "Yeast growth" already has this page. Lab notebook id: ${OTHER_ID}.`
    );
  });
});

describe("delete_lab_notebook and restore_lab_notebook", () => {
  it("delete acts as the signed-in user and returns the deleted lab notebook", async () => {
    const result = await tool("delete_lab_notebook")(
      { labNotebookId: NOTEBOOK_ID },
      writeCtx
    );

    expect(deleteNotebook).toHaveBeenCalledWith({
      id: NOTEBOOK_ID,
      actor: ACTOR,
    });
    expect(result.structuredContent).toMatchObject({
      id: NOTEBOOK_ID,
      deleted_at: "2026-11-14T00:00:00.000Z",
    });
  });

  it("delete refuses a session without the write scope", async () => {
    const result = await tool("delete_lab_notebook")(
      { labNotebookId: NOTEBOOK_ID },
      readCtx
    );

    expect(result.isError).toBe(true);
    expect(deleteNotebook).not.toHaveBeenCalled();
  });

  it("restore acts as the signed-in user and passes errors through", async () => {
    restoreNotebook.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "This lab notebook isn't deleted",
    });

    const result = await tool("restore_lab_notebook")(
      { labNotebookId: NOTEBOOK_ID },
      writeCtx
    );

    expect(restoreNotebook).toHaveBeenCalledWith({
      id: NOTEBOOK_ID,
      actor: ACTOR,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("This lab notebook isn't deleted");
  });
});

describe("add_runs_to_lab_notebook and remove_runs_from_lab_notebook", () => {
  it("adds every named run as the signed-in user and counts the outcomes", async () => {
    const result = await tool("add_runs_to_lab_notebook")(
      {
        labNotebookId: NOTEBOOK_ID,
        instrumentId: "inst",
        runIds: ["RUN1", "RUN2"],
      },
      writeCtx
    );

    expect(addRunsToNotebook).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      runs: [
        { instrumentId: "inst", runId: "RUN1" },
        { instrumentId: "inst", runId: "RUN2" },
      ],
      actor: ACTOR,
    });
    expect(result.structuredContent).toEqual({
      labNotebookId: NOTEBOOK_ID,
      instrumentId: "inst",
      results: [
        { runId: "RUN1", outcome: "added" },
        { runId: "RUN2", outcome: "not_found" },
      ],
      counts: {
        added: 1,
        already_in_lab_notebook: 0,
        run_deleted: 0,
        limit_reached: 0,
        not_found: 1,
      },
    });
  });

  it("removes every named run and counts the outcomes", async () => {
    const result = await tool("remove_runs_from_lab_notebook")(
      { labNotebookId: NOTEBOOK_ID, instrumentId: "inst", runIds: ["RUN1"] },
      writeCtx
    );

    expect(removeRunsFromNotebook).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      runs: [{ instrumentId: "inst", runId: "RUN1" }],
    });
    expect(result.structuredContent).toMatchObject({
      results: [{ runId: "RUN1", outcome: "removed" }],
      counts: { removed: 1, not_in_lab_notebook: 0 },
    });
  });

  it("remove refuses a session without the write scope", async () => {
    const result = await tool("remove_runs_from_lab_notebook")(
      { labNotebookId: NOTEBOOK_ID, instrumentId: "inst", runIds: ["RUN1"] },
      readCtx
    );

    expect(result.isError).toBe(true);
    expect(removeRunsFromNotebook).not.toHaveBeenCalled();
  });
});
