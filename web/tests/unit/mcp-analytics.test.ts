import { Client } from "@modelcontextprotocol/client";
import {
  type AuthInfo,
  InMemoryTransport,
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const trackEvent = vi.fn();
const mcpClientLabel = vi.fn(async (_authInfo?: unknown) => "Cursor");

vi.mock("@/lib/db", () => ({
  db: {},
}));

vi.mock("@/lib/analytics/track", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/track")>();
  return {
    ...actual,
    trackEvent: (...args: unknown[]) => trackEvent(...args),
  };
});

vi.mock("@/lib/mcp/client-name", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/client-name")>();
  return {
    ...actual,
    mcpClientLabel: (authInfo: unknown) => mcpClientLabel(authInfo),
  };
});

import { trackMcpConnect, withMcpTracking } from "@/lib/mcp/analytics";

const authInfo: AuthInfo = {
  token: "token",
  clientId: "client-1",
  scopes: ["read"],
  extra: { userId: "user-1" },
};

function httpCtx(info: AuthInfo | undefined = authInfo) {
  return { http: { authInfo: info } };
}

function trackedServer() {
  const server = new McpServer({ name: "data-hub-test", version: "0.0.0" });
  return withMcpTracking(server);
}

async function lastProps(): Promise<Record<string, unknown>> {
  const props = trackEvent.mock.calls.at(-1)?.[1];
  return typeof props === "function" ? await props() : props;
}

describe("withMcpTracking", () => {
  beforeEach(() => {
    trackEvent.mockReset();
    mcpClientLabel.mockClear();
    vi.restoreAllMocks();
  });

  it("records a schemaless tool, which the SDK calls with context only", async () => {
    const server = trackedServer();
    const tool = server.registerTool(
      "get_me",
      { description: "who" },
      async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      })
    );
    await tool.executor({}, httpCtx() as never);
    expect(trackEvent.mock.calls[0]?.[0]).toBe("mcp_tool_call");
    await expect(lastProps()).resolves.toMatchObject({
      user_id: "user-1",
      tool: "get_me",
      client: "Cursor",
      outcome: "ok",
      auth: "oauth",
    });
  });

  it("records an ok tool call and its duration bucket", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1500);
    const server = trackedServer();
    const tool = server.registerTool(
      "search_runs",
      { inputSchema: z.object({ q: z.string() }) },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] })
    );
    await tool.executor({ q: "plate" }, httpCtx() as never);
    await expect(lastProps()).resolves.toMatchObject({
      tool: "search_runs",
      outcome: "ok",
      duration_bucket: "1_to_5s",
      auth: "oauth",
    });
  });

  it("counts an isError result as a tool error", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const server = trackedServer();
    const tool = server.registerTool(
      "claim_run",
      { inputSchema: z.object({}) },
      async () => ({
        isError: true,
        content: [{ type: "text" as const, text: "no" }],
      })
    );
    await tool.executor({}, httpCtx() as never);
    await expect(lastProps()).resolves.toMatchObject({
      outcome: "tool_error",
      duration_bucket: "under_1s",
    });
  });

  it("records an exception and rethrows it", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(31_000);
    const server = trackedServer();
    const tool = server.registerTool(
      "get_run",
      { inputSchema: z.object({}) },
      () => {
        throw new Error("db down");
      }
    );
    await expect(tool.executor({}, httpCtx() as never)).rejects.toThrow(
      "db down"
    );
    await expect(lastProps()).resolves.toMatchObject({
      outcome: "exception",
      duration_bucket: "over_30s",
    });
  });

  it("buckets a multi-second call", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(8000);
    const server = trackedServer();
    const tool = server.registerTool(
      "get_file",
      { description: "file" },
      async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      })
    );
    await tool.executor({}, httpCtx() as never);
    await expect(lastProps()).resolves.toMatchObject({
      duration_bucket: "5_to_30s",
    });
  });

  it("labels a personal access token", async () => {
    const server = trackedServer();
    const tool = server.registerTool(
      "get_me",
      { description: "who" },
      async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      })
    );
    await tool.executor(
      {},
      httpCtx({ ...authInfo, clientId: "user-1" }) as never
    );
    await expect(lastProps()).resolves.toMatchObject({ auth: "pat" });
  });

  it("skips tool events when the caller is anonymous", async () => {
    const server = trackedServer();
    const tool = server.registerTool(
      "get_me",
      { description: "who" },
      async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      })
    );
    await tool.executor({}, { http: {} } as never);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("records the resource name and never the URI", async () => {
    const server = trackedServer();
    const resource = server.registerResource(
      "instrument-filter-options",
      new ResourceTemplate(
        "datahub://instruments/{instrumentId}/filter-options",
        {
          list: undefined,
        }
      ),
      { description: "filters" },
      async () => ({ contents: [] })
    );
    await resource.readCallback(
      new URL("datahub://instruments/akta-fplc/filter-options"),
      { instrumentId: "akta-fplc" },
      httpCtx() as never
    );
    const props = await lastProps();
    expect(trackEvent.mock.calls[0]?.[0]).toBe("mcp_resource_read");
    expect(props).toEqual({
      user_id: "user-1",
      resource: "instrument-filter-options",
      client: "Cursor",
      outcome: "ok",
    });
    expect(JSON.stringify(props)).not.toContain("akta-fplc");
  });

  it("records a static resource read", async () => {
    const server = trackedServer();
    const resource = server.registerResource(
      "me",
      "datahub://me",
      { description: "me" },
      async () => ({ contents: [] })
    );
    await resource.readCallback(new URL("datahub://me"), httpCtx() as never);
    await expect(lastProps()).resolves.toMatchObject({
      resource: "me",
      outcome: "ok",
    });
  });

  it("records a resource exception", async () => {
    const server = trackedServer();
    const resource = server.registerResource(
      "me",
      "datahub://me",
      { description: "me" },
      () => {
        throw new Error("nope");
      }
    );
    await expect(
      resource.readCallback(new URL("datahub://me"), httpCtx() as never)
    ).rejects.toThrow("nope");
    await expect(lastProps()).resolves.toMatchObject({ outcome: "exception" });
  });

  it("records a prompt that takes arguments", async () => {
    const server = trackedServer();
    const prompt = server.registerPrompt(
      "daily_summary",
      { argsSchema: z.object({ date: z.string() }) },
      async () => ({ messages: [] })
    );
    await prompt.handler({ date: "2026-01-01" }, httpCtx() as never);
    await expect(lastProps()).resolves.toEqual({
      user_id: "user-1",
      prompt: "daily_summary",
      client: "Cursor",
    });
  });

  it("records a prompt the SDK calls with context only", async () => {
    const server = trackedServer();
    const prompt = server.registerPrompt(
      "find_my_runs",
      { description: "mine" },
      async () => ({ messages: [] })
    );
    await prompt.handler({}, httpCtx() as never);
    await expect(lastProps()).resolves.toMatchObject({
      prompt: "find_my_runs",
    });
  });

  it("still serves a schemaless tool over the MCP transport", async () => {
    const server = trackedServer();
    server.registerTool(
      "get_system_status",
      { description: "status" },
      async () => ({
        content: [{ type: "text" as const, text: "up" }],
      })
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const result = await client.callTool({
      name: "get_system_status",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    await client.close();
    await server.close();
  });
});

describe("trackMcpConnect", () => {
  beforeEach(() => {
    trackEvent.mockReset();
  });

  it("records client info from an initialize body", async () => {
    const req = new Request("https://example.test/mcp/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "initialize",
        params: { clientInfo: { name: "Cursor", version: "1.2.3" } },
      }),
    });
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    trackMcpConnect(req);
    await vi.waitFor(() => {
      expect(trackEvent).toHaveBeenCalledWith("mcp_connect", {
        user_id: "user-1",
        client: "Cursor",
        client_version: "1.2.3",
      });
    });
  });

  it("ignores other methods", async () => {
    const req = new Request("https://example.test/mcp/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "tools/call" }),
    });
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    trackMcpConnect(req);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trackEvent).not.toHaveBeenCalled();
  });
});
