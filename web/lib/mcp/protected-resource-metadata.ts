import {
  generateProtectedResourceMetadata,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";
import { authIssuer, mcpResourceAudience } from "@/lib/auth";

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
      // Advertise the MCP scope pair so clients that read PRM (not only the
      // WWW-Authenticate challenge) still request write as well as read.
      additionalMetadata: {
        scopes_supported: ["read", "write"],
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
