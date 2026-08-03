import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { authBaseURL } from "@/lib/auth";
import { verifyMcpToken } from "@/lib/mcp/auth";
import { registerPrompts } from "@/lib/mcp/prompts";
import { registerResources } from "@/lib/mcp/resources";
import { registerTools } from "@/lib/mcp/tools";

export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    registerTools(server);
    registerResources(server);
    registerPrompts(server);
  },
  {
    serverInfo: { name: "data-hub", version: "1.0.0" },
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
    verboseLogs: process.env.NODE_ENV !== "production",
  }
);

// withMcpAuth treats resourceUrl as an origin and concatenates
// resourceMetadataPath onto it for the WWW-Authenticate challenge — so pass
// the app origin, not `mcpResourceAudience` (`…/mcp/v1`).
// Advertise both MCP scopes in the WWW-Authenticate challenge. Clients
// such as Cursor copy `scope=` from the challenge when requesting an
// authorization code — listing only `read` made consent appear read-only.
const authHandler = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  requiredScopes: ["read", "write"],
  resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp/v1",
  resourceUrl: authBaseURL,
});

export { authHandler as GET, authHandler as POST };
