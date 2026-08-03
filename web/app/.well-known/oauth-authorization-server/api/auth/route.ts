import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { authInstance } from "@/lib/auth";

// Path-aware RFC 8414 alias for issuer `{origin}/api/auth`.
export const GET = oauthProviderAuthServerMetadata(authInstance);
