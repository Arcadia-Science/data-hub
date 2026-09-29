import {
  Client,
  type ListChangedHandlers,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "mcp-handler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refuseListenStreams } from "@/lib/mcp/listen-streams";

const MODERN_REVISION = "2026-07-28";

const handler = createMcpHandler((server) => {
  server.registerTool("ping", { description: "Replies pong." }, () => ({
    content: [{ text: "pong", type: "text" }],
  }));
  server.registerResource("note", "datahub://note", {}, (uri) => ({
    contents: [{ text: "note", uri: uri.href }],
  }));
  server.registerPrompt("greet", { description: "Says hello." }, () => ({
    messages: [
      {
        content: { text: "hello", type: "text" },
        role: "user",
      },
    ],
  }));
}, refuseListenStreams);

const openClients: Client[] = [];

async function connectModern(
  listChanged?: ListChangedHandlers
): Promise<Client> {
  const client = new Client(
    { name: "listen-streams-test", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: MODERN_REVISION } },
      ...(listChanged ? { listChanged } : {}),
    }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost/mcp"),
    { fetch: (url, init) => handler(new Request(url, init)) }
  );
  await client.connect(transport);
  openClients.push(client);
  return client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("MCP listen streams", () => {
  it("advertises unchanging lists, so a client skips opening a listen stream", async () => {
    const client = await connectModern({
      prompts: { onChanged: () => undefined },
      resources: { onChanged: () => undefined },
      tools: { onChanged: () => undefined },
    });

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools?.listChanged).toBe(false);
    expect(capabilities?.resources?.listChanged).toBe(false);
    expect(capabilities?.prompts?.listChanged).toBe(false);
    expect(client.autoOpenedSubscription).toBeUndefined();

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["ping"]);
  });

  it("refuses a listen request and logs one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = await connectModern();

    await expect(client.listen({ toolsListChanged: true })).rejects.toThrow(
      /Subscription limit reached/
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[mcp] refused subscriptions/listen");
  });
});
