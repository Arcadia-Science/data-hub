import type { McpHandlerOptions } from "mcp-handler";

const REFUSED_LISTEN = "subscriptions/listen refused";

/**
 * Handler options that keep MCP clients from holding `subscriptions/listen`
 * streams open. Data Hub never sends change notifications, and the SDK keeps
 * its notification bus in one instance's memory, so a stream would sit idle
 * until Vercel's `maxDuration` kills it and the client opens another.
 *
 * The SDK advertises `listChanged: true` once a tool, resource, or prompt is
 * registered unless told otherwise. `maxSubscriptions: 0` refuses clients
 * that ask anyway. Each refusal logs one stable line so the rate can be
 * counted in production, where `verboseLogs` is off.
 */
export const refuseListenStreams = {
  capabilities: {
    prompts: { listChanged: false },
    resources: { listChanged: false },
    tools: { listChanged: false },
  },
  maxSubscriptions: 0,
  onEvent: (event) => {
    if (event.type !== "ERROR") {
      return;
    }
    const message =
      typeof event.error === "string" ? event.error : event.error.message;
    if (message.startsWith(REFUSED_LISTEN)) {
      console.warn("[mcp] refused subscriptions/listen");
    }
  },
} satisfies McpHandlerOptions;
