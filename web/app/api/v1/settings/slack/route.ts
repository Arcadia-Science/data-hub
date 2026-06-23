// GET /api/v1/settings/slack
//
// Returns the current user's Slack connection state (or null if not
// connected). Used by the settings page to render the correct connect /
// disconnect UI without a full page reload after the OAuth callback.

import { requireSession } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED } from "@/lib/api/errors";
import { getSlackConnection } from "@/lib/slack/connections";

export async function GET() {
  const auth = await requireSession();
  if (!auth) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const connection = await getSlackConnection(auth.userId);
  if (!connection) {
    return Response.json({ connected: false });
  }

  return Response.json({
    connected: true,
    slack_user_id: connection.slackUserId,
    slack_team_id: connection.slackTeamId,
    slack_team_name: connection.slackTeamName,
    connected_at: connection.connectedAt.toISOString(),
    revoked: connection.revokedAt !== null,
  });
}
