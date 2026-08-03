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

function handler() {
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

const corsHandler = metadataCorsOptionsRequestHandler();

export { corsHandler as OPTIONS, handler as GET };
