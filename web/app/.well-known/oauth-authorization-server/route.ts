import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { authInstance } from "@/lib/auth";

export const GET = oauthProviderAuthServerMetadata(authInstance);
