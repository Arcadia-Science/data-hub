import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { authInstance } from "@/lib/auth";

export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields<typeof authInstance>(),
    // Attaches signed `oauth_query` from the current URL during MCP authorize
    // so Better Auth can resume the OAuth flow after Google sign-in.
    oauthProviderClient(),
  ],
});

export const { signIn, signOut, useSession } = authClient;
