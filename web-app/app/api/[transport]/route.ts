import { authenticateRequest } from "@/lib/api/auth";
import { registerPrompts } from "@/lib/mcp/prompts";
import { registerResources } from "@/lib/mcp/resources";
import { registerTools } from "@/lib/mcp/tools";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { NextRequest } from "next/server";

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
    basePath: "/api",
    maxDuration: 60,
  }
);

const verifyToken = async (
  req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  const nextReq = new NextRequest(req);
  const result = await authenticateRequest(nextReq);
  if (!result) return undefined;
  return {
    token: bearerToken ?? "",
    clientId: result.userId,
    scopes: ["read"],
    extra: { userId: result.userId, authMethod: result.authMethod },
  };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST };
