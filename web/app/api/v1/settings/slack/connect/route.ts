// GET /api/v1/settings/slack/connect
//
// Redirects the current user to the Slack OIDC authorization URL.
// Using GET + redirect lets the UI render a plain <a> with no client JS.
// The signed `state` binds the flow to the current user so the callback
// can verify we're completing the flow we started.

import { type NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED } from "@/lib/api/errors";
import { getSlackRedirectUri } from "@/lib/slack/oauth";
import { generateState } from "@/lib/slack/state";

function getSlackClientId(): string | null {
  return process.env.SLACK_CLIENT_ID ?? null;
}

export async function GET(request: NextRequest) {
  const auth = await requireSession();
  if (!auth) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const clientId = getSlackClientId();
  if (!clientId) {
    return apiError(500, "CONFIGURATION_ERROR", "Slack is not configured");
  }

  const origin = new URL(request.url).origin;
  const redirectUri = getSlackRedirectUri(origin);
  const state = generateState(auth.userId);

  const params = new URLSearchParams({
    client_id: clientId,
    scope: "",
    // Request the user's own identity via OIDC so we get their Slack user ID
    // without any write permissions to the workspace.
    user_scope: "openid,profile",
    redirect_uri: redirectUri,
    state,
  });

  const authorizeUrl = `https://slack.com/openid/connect/authorize?${params}`;
  return NextResponse.redirect(authorizeUrl);
}
