import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";
import { authIssuer, mcpResourceAudience } from "@/lib/auth";

const handler = protectedResourceHandler({
  // RFC 9728: authorization_servers entries are issuer identifiers.
  authServerUrls: [authIssuer],
  resourceUrl: mcpResourceAudience,
});

const corsHandler = metadataCorsOptionsRequestHandler();

export { corsHandler as OPTIONS, handler as GET };
