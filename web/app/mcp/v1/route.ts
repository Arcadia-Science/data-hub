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
//
// Enforce only `read` at the transport so read-only tokens can connect;
// mutating tools still gate on `write` via `requireMcpWrite`. Advertise both
// scopes in the challenge below — clients such as Cursor copy `scope=` when
// requesting an authorization code, and `requiredScopes` alone would make
// `write` mandatory for every connection.
const mcpAuthHandler = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  requiredScopes: ["read"],
  resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp/v1",
  resourceUrl: authBaseURL,
});

const ADVERTISED_SCOPES = 'scope="read write"';

async function authHandler(req: Request): Promise<Response> {
  const res = await mcpAuthHandler(req);
  const challenge = res.headers.get("WWW-Authenticate");
  if (!challenge || challenge.includes("write")) {
    return res;
  }
  const rewritten = challenge.replace(/scope="[^"]*"/, ADVERTISED_SCOPES);
  if (rewritten === challenge) {
    return res;
  }
  const headers = new Headers(res.headers);
  headers.set("WWW-Authenticate", rewritten);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export { authHandler as GET, authHandler as POST };
