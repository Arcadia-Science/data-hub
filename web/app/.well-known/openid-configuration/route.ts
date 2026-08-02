import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { authInstance } from "@/lib/auth";

export const GET = oauthProviderOpenIdConfigMetadata(authInstance);
