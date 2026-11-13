import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `add_run_comment` sends the run ID to the Slack message and its link. A call
// that names the run as ` RUN1 ` must send `RUN1`, the ID saved on the run. The
// integration suite can't see this, because its server has no production URL
// and so sends no Slack message. The run lookup and the comment write are
// replaced, so the test checks only what the tool passes on.

const { lookupRunByNaturalKey, createCommentAndNotify } = vi.hoisted(() => ({
  lookupRunByNaturalKey: vi.fn(),
  createCommentAndNotify: vi.fn(),
}));

vi.mock("@/lib/api/instrument-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/instrument-runs")>()),
  lookupRunByNaturalKey,
}));
vi.mock("@/lib/api/run-comments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/run-comments")>()),
  createCommentAndNotify,
}));
vi.mock("@/lib/api/run-comment-wire", () => ({
  commentToWire: (comment: unknown) => comment,
}));

import { registerRunTools } from "@/lib/mcp/tools/runs";

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { http: { authInfo: AuthInfo } }
) => Promise<{ isError?: boolean }>;

function registeredTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerRunTools(server as unknown as McpServer);
  return tools;
}

const ctx = {
  http: {
    authInfo: {
      token: "token",
      clientId: "client-1",
      scopes: ["read", "write"],
      extra: { userId: "user-1" },
    },
  },
};

describe("add_run_comment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupRunByNaturalKey.mockResolvedValue({
      id: "run-uuid",
      runId: "RUN1",
      instrumentId: "inst",
      instrumentDisplayName: "Plate reader",
      deletedAt: null,
    });
    createCommentAndNotify.mockResolvedValue({ id: "comment-1" });
  });

  it("labels the notification with the stored run ID, not the one in the call", async () => {
    const addRunComment = registeredTools().get("add_run_comment");
    if (!addRunComment) {
      throw new Error("add_run_comment is not registered");
    }

    const result = await addRunComment(
      { instrumentId: "inst", runId: " RUN1 ", body: "Looks good." },
      ctx
    );

    expect(result.isError).toBeFalsy();
    expect(lookupRunByNaturalKey).toHaveBeenCalledWith("inst", " RUN1 ");
    expect(createCommentAndNotify).toHaveBeenCalledTimes(1);
    expect(createCommentAndNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        runInternalId: "run-uuid",
        instrumentId: "inst",
        runDisplayId: "RUN1",
      })
    );
  });
});
