import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { authenticateWithToken } from "@/lib/api/auth";
import { registerPrompts } from "@/lib/mcp/prompts";
import { registerResources } from "@/lib/mcp/resources";
import { registerTools } from "@/lib/mcp/tools";

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

// Pass the PAT's resource scopes through to the MCP layer unchanged. Each
// tool checks the same `<resource>:<action>` scope its REST counterpart
// does (see `requireMcpScope` in `lib/mcp/tools.ts`), so there's no
// MCP-specific scope vocabulary and no connect-time gate beyond a valid
// token. The `*` wildcard from legacy/backfilled tokens is honored by
// `hasScope`, so deployed watchers and the Lambda keep working.
const verifyToken = async (
  req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  const result = await authenticateWithToken(req);
  if (!result) {
    return;
  }

  return {
    token: bearerToken ?? "",
    clientId: result.userId,
    scopes: result.scopes,
    extra: { userId: result.userId, authMethod: result.authMethod },
  };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST };
