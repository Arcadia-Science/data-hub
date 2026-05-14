import { authenticateWithToken } from "@/lib/api/auth";
import { hasScope } from "@/lib/api/scopes";
import { registerPrompts } from "@/lib/mcp/prompts";
import { registerResources } from "@/lib/mcp/resources";
import { registerTools } from "@/lib/mcp/tools";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpHandler, withMcpAuth } from "mcp-handler";

const handler = createMcpHandler(
  (server) => {
    registerTools(server);
    registerResources(server);
    registerPrompts(server);
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  },
  {
    basePath: "/api/v1",
    maxDuration: 60,
  }
);

// Translate the PAT's internal scope vocabulary to the MCP-facing
// `["read", "write"]` shape the SDK exposes to clients. The MCP surface
// is gated as a whole on `mcp:read` (any caller without it is rejected
// here); finer-grained `mcp:write` then controls the mutating tools via
// `requireMcpScope` inside the tool implementations.
const verifyToken = async (
  req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  const result = await authenticateWithToken(req);
  if (!result) return undefined;

  if (!hasScope(result, "mcp:read")) return undefined;

  const mcpScopes: string[] = ["read"];
  if (hasScope(result, "mcp:write")) {
    mcpScopes.push("write");
  }

  return {
    token: bearerToken ?? "",
    clientId: result.userId,
    scopes: mcpScopes,
    extra: { userId: result.userId, authMethod: result.authMethod },
  };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST };
