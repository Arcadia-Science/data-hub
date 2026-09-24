import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { durationBucket, trackEvent } from "@/lib/analytics/track";
import { isPatAuth, mcpClientLabel } from "@/lib/mcp/client-name";

function mcpUserId(authInfo: AuthInfo | undefined): string | undefined {
  const userId = authInfo?.extra?.userId;
  return typeof userId === "string" ? userId : undefined;
}

interface HttpAuth {
  http?: { authInfo?: AuthInfo };
}

function userIdFrom(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object" || !("http" in ctx)) {
    return;
  }
  return mcpUserId((ctx as HttpAuth).http?.authInfo);
}

function authInfoFrom(ctx: unknown): AuthInfo | undefined {
  if (!ctx || typeof ctx !== "object" || !("http" in ctx)) {
    return;
  }
  return (ctx as HttpAuth).http?.authInfo;
}

function reportTool(
  tool: string,
  ctx: unknown,
  outcome: "ok" | "tool_error" | "exception",
  elapsedMs: number
): void {
  const userId = userIdFrom(ctx);
  if (!userId) {
    return;
  }
  const authInfo = authInfoFrom(ctx);
  trackEvent("mcp_tool_call", async () => ({
    user_id: userId,
    tool,
    client: await mcpClientLabel(authInfo),
    outcome,
    duration_bucket: durationBucket(elapsedMs),
    auth: isPatAuth(authInfo) ? "pat" : "oauth",
  }));
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
    registerTool(name, config, async (args, ctx) => {
      const started = Date.now();
      try {
        const result = await cb(args, ctx);
        reportTool(
          name,
          ctx,
          isToolError(result) ? "tool_error" : "ok",
          Date.now() - started
        );
        return result;
      } catch (error) {
        reportTool(name, ctx, "exception", Date.now() - started);
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
        const userId = userIdFrom(ctx);
        try {
          const result = await readCallback(...args);
          if (userId) {
            const authInfo = authInfoFrom(ctx);
            trackEvent("mcp_resource_read", async () => ({
              user_id: userId,
              resource: name,
              client: await mcpClientLabel(authInfo),
              outcome: "ok",
            }));
          }
          return result;
        } catch (error) {
          if (userId) {
            const authInfo = authInfoFrom(ctx);
            trackEvent("mcp_resource_read", async () => ({
              user_id: userId,
              resource: name,
              client: await mcpClientLabel(authInfo),
              outcome: "exception",
            }));
          }
          throw error;
        }
      }
    );

  loose.registerPrompt = (name, config, cb) =>
    registerPrompt(name, config, async (...args: unknown[]) => {
      const ctx = args.at(-1);
      const userId = userIdFrom(ctx);
      const result = await cb(...args);
      if (userId) {
        const authInfo = authInfoFrom(ctx);
        trackEvent("mcp_prompt_get", async () => ({
          user_id: userId,
          prompt: name,
          client: await mcpClientLabel(authInfo),
        }));
      }
      return result;
    });

  return server;
}
