import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const trackEvent = vi.fn();
const mcpClientLabel = vi.fn(async (_authInfo?: unknown) => "Cursor");

vi.mock("@/lib/analytics/track", () => ({
  durationBucket: (elapsedMs: number) => {
    if (elapsedMs < 1000) {
      return "under_1s";
    }
    if (elapsedMs < 5000) {
      return "1_to_5s";
    }
    if (elapsedMs < 30_000) {
      return "5_to_30s";
    }
    return "over_30s";
  },
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}));

vi.mock("@/lib/mcp/client-name", () => ({
  isPatAuth: (authInfo: AuthInfo | undefined) =>
    Boolean(
      authInfo &&
        typeof authInfo.extra?.userId === "string" &&
        authInfo.clientId === authInfo.extra.userId
    ),
  mcpClientLabel: (authInfo: unknown) => mcpClientLabel(authInfo),
}));

import { trackMcpConnect, withMcpTracking } from "@/lib/mcp/analytics";

const authInfo: AuthInfo = {
  token: "token",
  clientId: "client-1",
  scopes: ["read"],
  extra: { userId: "user-1" },
};

function ctx() {
  return { http: { authInfo } };
}

type AnyFn = (...args: unknown[]) => Promise<unknown>;

function trackedServer() {
  const calls = {
    tool: undefined as AnyFn | undefined,
    resource: undefined as AnyFn | undefined,
    prompt: undefined as AnyFn | undefined,
  };
  const server = {
    registerTool(_name: string, _config: unknown, cb: AnyFn) {
      calls.tool = cb;
    },
    registerResource(
      _name: string,
      _uri: unknown,
      _config: unknown,
      cb: AnyFn
    ) {
      calls.resource = cb;
    },
    registerPrompt(_name: string, _config: unknown, cb: AnyFn) {
      calls.prompt = cb;
    },
  };
  const tracked = withMcpTracking(
    server as unknown as McpServer
  ) as unknown as {
    registerTool: (name: string, config: unknown, cb: AnyFn) => void;
    registerResource: (
      name: string,
      uri: unknown,
      config: unknown,
      cb: AnyFn
    ) => void;
    registerPrompt: (name: string, config: unknown, cb: AnyFn) => void;
  };
  return { tracked, calls };
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

  it("records an ok tool call and its duration bucket", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1500);
    const { tracked, calls } = trackedServer();
    tracked.registerTool("search_runs", {}, async () => ({ content: [] }));
    await calls.tool?.({}, ctx());
    expect(trackEvent.mock.calls[0]?.[0]).toBe("mcp_tool_call");
    await expect(lastProps()).resolves.toEqual({
      user_id: "user-1",
      tool: "search_runs",
      client: "Cursor",
      outcome: "ok",
      duration_bucket: "1_to_5s",
      auth: "oauth",
    });
  });

  it("counts an isError result as a tool error", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const { tracked, calls } = trackedServer();
    tracked.registerTool("claim_run", {}, async () => ({
      isError: true,
      content: [],
    }));
    await calls.tool?.({}, ctx());
    await expect(lastProps()).resolves.toMatchObject({
      outcome: "tool_error",
      duration_bucket: "under_1s",
    });
  });

  it("records an exception and rethrows it", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(31_000);
    const { tracked, calls } = trackedServer();
    tracked.registerTool("get_run", {}, () => {
      throw new Error("db down");
    });
    await expect(calls.tool?.({}, ctx())).rejects.toThrow("db down");
    await expect(lastProps()).resolves.toMatchObject({
      outcome: "exception",
      duration_bucket: "over_30s",
    });
  });

  it("buckets a multi-second call", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(8000);
    const { tracked, calls } = trackedServer();
    tracked.registerTool("get_file", {}, async () => ({ content: [] }));
    await calls.tool?.({}, ctx());
    await expect(lastProps()).resolves.toMatchObject({
      duration_bucket: "5_to_30s",
    });
  });

  it("skips tool events when the caller is anonymous", async () => {
    const { tracked, calls } = trackedServer();
    tracked.registerTool("get_me", {}, async () => ({ content: [] }));
    await calls.tool?.({}, { http: {} });
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("records the resource name and never the URI", async () => {
    const { tracked, calls } = trackedServer();
    tracked.registerResource(
      "instrument-filter-options",
      "datahub://instruments/akta-fplc/filter-options",
      {},
      async () => ({ contents: [] })
    );
    await calls.resource?.(
      new URL("datahub://instruments/akta-fplc/filter-options"),
      ctx()
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

  it("records a resource exception", async () => {
    const { tracked, calls } = trackedServer();
    tracked.registerResource("me", "datahub://me", {}, () => {
      throw new Error("nope");
    });
    await expect(
      calls.resource?.(new URL("datahub://me"), ctx())
    ).rejects.toThrow("nope");
    await expect(lastProps()).resolves.toMatchObject({ outcome: "exception" });
  });

  it("records a prompt by name", async () => {
    const { tracked, calls } = trackedServer();
    tracked.registerPrompt("daily_summary", {}, async () => ({ messages: [] }));
    await calls.prompt?.({}, ctx());
    await expect(lastProps()).resolves.toEqual({
      user_id: "user-1",
      prompt: "daily_summary",
      client: "Cursor",
    });
    expect(trackEvent.mock.calls[0]?.[0]).toBe("mcp_prompt_get");
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
