import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { authBaseURL } from "@/lib/auth";
import { MCP_ADVERTISED_SCOPES } from "@/lib/mcp/advertised-scopes";
import { verifyMcpToken } from "@/lib/mcp/auth";
import { mcpCorsPreflight, withMcpCors } from "@/lib/mcp/cors";
import { MCP_SERVER_INSTRUCTIONS } from "@/lib/mcp/instructions";
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
    instructions: MCP_SERVER_INSTRUCTIONS,
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
//
// Enforce only `read` at the transport so read-only tokens can connect;
// mutating tools still gate on `write` via `requireMcpWrite`. The challenge
// below advertises the wider set — clients such as Cursor copy `scope=` when
// requesting an authorization code, and `requiredScopes` alone would make
// every advertised scope mandatory for every connection.
const mcpAuthHandler = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  requiredScopes: ["read"],
  resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp/v1",
  resourceUrl: authBaseURL,
});

const ADVERTISED_SCOPES = `scope="${MCP_ADVERTISED_SCOPES.join(" ")}"`;

async function authHandler(req: Request): Promise<Response> {
  const res = await mcpAuthHandler(req);
  const challenge = res.headers.get("WWW-Authenticate");
  if (!challenge || challenge.includes(ADVERTISED_SCOPES)) {
    return withMcpCors(res);
  }
  const rewritten = challenge.replace(/scope="[^"]*"/, ADVERTISED_SCOPES);
  if (rewritten === challenge) {
    return withMcpCors(res);
  }
  const headers = new Headers(res.headers);
  headers.set("WWW-Authenticate", rewritten);
  return withMcpCors(
    new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  );
}

export function OPTIONS(): Response {
  return mcpCorsPreflight();
}

export { authHandler as GET, authHandler as POST };
