import {
  generateProtectedResourceMetadata,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";
import { authIssuer, mcpResourceAudience } from "@/lib/auth";
import { MCP_ADVERTISED_SCOPES } from "@/lib/mcp/advertised-scopes";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

/**
 * Shared handlers for `/.well-known/oauth-protected-resource` and the
 * resource-specific `…/mcp/v1` path. Both advertise the MCP resource URL so
 * clients that probe either location discover the same AS + scopes.
 */
export function createProtectedResourceHandlers() {
  function GET() {
    const metadata = generateProtectedResourceMetadata({
      authServerUrls: [authIssuer],
      resourceUrl: mcpResourceAudience,
      // Clients that read PRM (not only the WWW-Authenticate challenge) must
      // see the same list, or they register with narrower scopes than they
      // later request.
      additionalMetadata: {
        scopes_supported: [...MCP_ADVERTISED_SCOPES],
      },
    });
    return Response.json(metadata, {
      headers: {
        ...corsHeaders,
        "Cache-Control": "max-age=3600",
        "Content-Type": "application/json",
      },
    });
  }

  return {
    GET,
    OPTIONS: metadataCorsOptionsRequestHandler(),
  };
}
