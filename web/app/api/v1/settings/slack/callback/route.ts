// GET /api/v1/settings/slack/callback
//
// OAuth callback handler. Slack redirects here after the user approves the
// OIDC request. We:
//   1. Verify the `state` parameter matches the current session.
//   2. Exchange the `code` for a token response via Slack's OIDC endpoint.
//   3. Decode the `id_token` JWT payload (base64url section [1]) to extract
//      the Slack user ID (`sub`), team ID, and team name without a second
//      network call. The token arrived directly from Slack over HTTPS so
//      we trust the payload without verifying the RS256 signature.
//   4. Upsert `slack_connections` and enable the three Slack prefs.
//   5. Redirect back to /settings/notifications with a result flag.

import { WebClient } from "@slack/web-api";
import { type NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED } from "@/lib/api/errors";
import { upsertSlackConnection } from "@/lib/slack/connections";
import { verifyState } from "@/lib/slack/state";

function getRedirectUri(origin: string): string {
  return (
    process.env.SLACK_REDIRECT_URI ?? `${origin}/api/v1/settings/slack/callback`
  );
}

/**
 * Decode a JWT's payload without verifying the signature. Safe here because
 * the token came from Slack's OIDC endpoint directly over HTTPS.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT");
  }
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload) as Record<string, unknown>;
}

const SETTINGS_URL = "/settings/notifications";

export async function GET(request: NextRequest) {
  const auth = await requireSession();
  if (!auth) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // User declined the OAuth prompt.
  if (error) {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=cancelled`, request.url)
    );
  }

  if (!(code && state)) {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=error`, request.url)
    );
  }

  // Verify the state was generated for this user and hasn't expired.
  let statePayload: { userId: string };
  try {
    statePayload = verifyState(state);
  } catch {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=error`, request.url)
    );
  }

  if (statePayload.userId !== auth.userId) {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=error`, request.url)
    );
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!(clientId && clientSecret)) {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=error`, request.url)
    );
  }

  const origin = new URL(request.url).origin;
  const redirectUri = getRedirectUri(origin);

  // Exchange the code for the OIDC token response.
  const anonClient = new WebClient();
  let idToken: string;
  try {
    const tokenResponse = await anonClient.openid.connect.token({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    if (!(tokenResponse.ok && tokenResponse.id_token)) {
      return NextResponse.redirect(
        new URL(`${SETTINGS_URL}?slack=error`, request.url)
      );
    }
    idToken = tokenResponse.id_token;
  } catch {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=error`, request.url)
    );
  }

  // Decode the JWT payload to extract identity fields.
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtPayload(idToken);
  } catch {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=error`, request.url)
    );
  }

  const slackUserId =
    typeof claims.sub === "string"
      ? claims.sub
      : typeof claims["https://slack.com/user_id"] === "string"
        ? claims["https://slack.com/user_id"]
        : null;
  const teamId =
    typeof claims["https://slack.com/team_id"] === "string"
      ? claims["https://slack.com/team_id"]
      : null;
  const teamName =
    typeof claims["https://slack.com/team_name"] === "string"
      ? claims["https://slack.com/team_name"]
      : null;

  if (!(slackUserId && teamId)) {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=error`, request.url)
    );
  }

  // Optionally enforce a specific workspace — prevents linking personal
  // workspaces when the org bot only has access to the company workspace.
  const expectedTeamId = process.env.SLACK_TEAM_ID;
  if (expectedTeamId && teamId !== expectedTeamId) {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=wrong_workspace`, request.url)
    );
  }

  try {
    await upsertSlackConnection(auth.userId, {
      slackUserId,
      slackTeamId: teamId,
      slackTeamName: teamName,
    });
  } catch {
    return NextResponse.redirect(
      new URL(`${SETTINGS_URL}?slack=error`, request.url)
    );
  }

  return NextResponse.redirect(
    new URL(`${SETTINGS_URL}?slack=connected`, request.url)
  );
}
