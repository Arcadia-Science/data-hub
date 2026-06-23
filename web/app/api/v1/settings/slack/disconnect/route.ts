// POST /api/v1/settings/slack/disconnect
//
// Removes the current user's Slack connection and disables the three Slack
// notification toggles. Does not revoke the Slack user token on Slack's side
// (the OIDC user_scope token has no revocation API beyond the user revoking
// app access themselves in Slack settings). The bot token is shared and is
// not per-user.

import { requireSession } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED } from "@/lib/api/errors";
import { deleteSlackConnection } from "@/lib/slack/connections";

export async function POST() {
  const auth = await requireSession();
  if (!auth) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  await deleteSlackConnection(auth.userId);
  return new Response(null, { status: 204 });
}
