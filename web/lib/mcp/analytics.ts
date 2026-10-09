import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import {
  type AnalyticsEvents,
  durationBucket,
  searchResultBucket,
  trackEvent,
} from "@/lib/analytics/track";
import { mcpClientLabel } from "@/lib/mcp/client-name";

function mcpUserId(authInfo: AuthInfo | undefined): string | undefined {
  const userId = authInfo?.extra?.userId;
  return typeof userId === "string" ? userId : undefined;
}

interface HttpAuth {
  http?: { authInfo?: AuthInfo };
}

function authInfoFrom(ctx: unknown): AuthInfo | undefined {
  if (!ctx || typeof ctx !== "object" || !("http" in ctx)) {
    return;
  }
  return (ctx as HttpAuth).http?.authInfo;
}

type CallerEventName =
  | "mcp_docs_read"
  | "mcp_docs_search"
  | "mcp_prompt_get"
  | "mcp_resource_read"
  | "mcp_tool_call";

/**
 * Records an event with the caller's user ID and client label. Calls without
 * a signed-in user, such as over the in-memory transport, record nothing.
 */
function trackForCaller<N extends CallerEventName>(
  name: N,
  ctx: unknown,
  props: Omit<AnalyticsEvents[N], "user_id" | "client">
): void {
  const authInfo = authInfoFrom(ctx);
  const userId = mcpUserId(authInfo);
  if (!userId) {
    return;
  }
  trackEvent(
    name,
    async () =>
      ({
        ...props,
        user_id: userId,
        client: await mcpClientLabel(authInfo),
      }) as AnalyticsEvents[N]
  );
}

/**
 * Counts docs searches by how many sections answer the question, so a rising
 * share of searches in the `0` bucket shows where the docs have gaps. The
 * query text is never recorded.
 */
export function trackDocsSearch(ctx: unknown, goodMatches: number): void {
  trackForCaller("mcp_docs_search", ctx, {
    result_bucket: searchResultBucket(goodMatches),
  });
}

/** Pass only a page ID that resolved against the bundle, not raw input. */
export function trackDocsRead(ctx: unknown, page: string): void {
  trackForCaller("mcp_docs_read", ctx, { page });
}

function isToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
}

const LABEL_MAX = 100;

function labelFrom(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const trimmed = value.trim().slice(0, LABEL_MAX);
  return trimmed.length > 0 ? trimmed : "unknown";
}

/**
 * Records an MCP `initialize` handshake. Call this from the route after auth
 * has attached `req.auth`, and before the handler runs.
 */
export function trackMcpConnect(req: Request): void {
  if (req.method !== "POST") {
    return;
  }
  const userId = mcpUserId(req.auth);
  if (!userId) {
    return;
  }

  void req
    .clone()
    .json()
    .then((body: unknown) => {
      const messages = Array.isArray(body) ? body : [body];
      for (const message of messages) {
        if (!message || typeof message !== "object" || !("method" in message)) {
          continue;
        }
        if (message.method !== "initialize") {
          continue;
        }
        const params =
          "params" in message &&
          message.params &&
          typeof message.params === "object"
            ? message.params
            : undefined;
        const clientInfo =
          params &&
          "clientInfo" in params &&
          params.clientInfo &&
          typeof params.clientInfo === "object"
            ? params.clientInfo
            : undefined;
        trackEvent("mcp_connect", {
          user_id: userId,
          client: labelFrom(
            clientInfo && "name" in clientInfo ? clientInfo.name : undefined
          ),
          client_version: labelFrom(
            clientInfo && "version" in clientInfo
              ? clientInfo.version
              : undefined
          ),
        });
      }
    })
    .catch(() => {
      // Non-JSON bodies are not handshakes.
    });
}

/**
 * Wraps tool, resource, and prompt registration so every call is counted
 * once, without editing each handler. Resource URIs are not recorded: template
 * URIs contain instrument ids.
 */
type AnyFn = (...args: unknown[]) => unknown;

// The SDK overloads `register*` on schema generics. A loose view keeps the
// wrapper in one place without re-declaring every overload.
interface LooseServer {
  registerPrompt: (name: string, config: unknown, cb: AnyFn) => unknown;
  registerResource: (
    name: string,
    uriOrTemplate: unknown,
    config: unknown,
    cb: AnyFn
  ) => unknown;
  registerTool: (name: string, config: unknown, cb: AnyFn) => unknown;
}

export function withMcpTracking(server: McpServer): McpServer {
  const loose = server as unknown as LooseServer;
  const registerTool = loose.registerTool.bind(loose);
  const registerResource = loose.registerResource.bind(loose);
  const registerPrompt = loose.registerPrompt.bind(loose);

  loose.registerTool = (name, config, cb) =>
    // Schemaless tools are invoked as `handler(ctx)`. Tools with an input
    // schema are `handler(args, ctx)`. The context is always last.
    registerTool(name, config, async (...args: unknown[]) => {
      const ctx = args.at(-1);
      const started = Date.now();
      try {
        const result = await cb(...args);
        trackForCaller("mcp_tool_call", ctx, {
          tool: name,
          outcome: isToolError(result) ? "tool_error" : "ok",
          duration_bucket: durationBucket(Date.now() - started),
        });
        return result;
      } catch (error) {
        trackForCaller("mcp_tool_call", ctx, {
          tool: name,
          outcome: "exception",
          duration_bucket: durationBucket(Date.now() - started),
        });
        throw error;
      }
    });

  loose.registerResource = (name, uriOrTemplate, config, readCallback) =>
    registerResource(
      name,
      uriOrTemplate,
      config,
      // Both static `(uri, ctx)` and template `(uri, variables, ctx)` pass
      // the server context last. The URI itself is never forwarded.
      async (...args: unknown[]) => {
        const ctx = args.at(-1);
        try {
          const result = await readCallback(...args);
          trackForCaller("mcp_resource_read", ctx, {
            resource: name,
            outcome: "ok",
          });
          return result;
        } catch (error) {
          trackForCaller("mcp_resource_read", ctx, {
            resource: name,
            outcome: "exception",
          });
          throw error;
        }
      }
    );

  loose.registerPrompt = (name, config, cb) =>
    registerPrompt(name, config, async (...args: unknown[]) => {
      const ctx = args.at(-1);
      const result = await cb(...args);
      trackForCaller("mcp_prompt_get", ctx, { prompt: name });
      return result;
    });

  return server;
}
