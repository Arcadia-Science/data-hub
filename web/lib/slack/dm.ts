// Sends personal Slack DMs via the shared org bot token.
//
// The bot posts to each recipient's Slack member ID directly — Slack
// auto-opens the DM channel when `channel` is a user ID with `chat:write`.
// No per-user token is stored; the shared `SLACK_BOT_TOKEN` env var is the
// only credential. Like the existing `sendSlackMessage` webhook helper, if
// the token is absent the function is a no-op so local dev and tests can opt
// out cleanly.
//
// Fatal Slack errors (token_revoked, account_inactive, user_not_found) are
// returned as a `{ revoked: true }` signal so callers can mark the
// `slack_connections.revoked_at` column. All failures are logged but never
// thrown — DMs are a side-channel and must not break the mutation that
// triggered the notification.

import type { Block, KnownBlock } from "@slack/web-api";
import { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { slackConnections } from "@/lib/db/schema";

// Errors returned by Slack that mean the user's connection is permanently
// broken and needs to be reconnected.
const REVOKED_ERRORS = new Set([
  "token_revoked",
  "account_inactive",
  "user_not_found",
  "not_authed",
  "invalid_auth",
]);

let _client: WebClient | null = null;

function getClient(): WebClient | null {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return null;
  }
  if (!_client) {
    // `slackApiUrl` can be overridden in tests to point at the in-process
    // capture server; in production it defaults to the real Slack API.
    const slackApiUrl = process.env.__TEST_SLACK_API_URL;
    _client = new WebClient(token, slackApiUrl ? { slackApiUrl } : undefined);
  }
  return _client;
}

export interface SlackDmPayload {
  blocks?: (Block | KnownBlock)[];
  text: string;
}

/**
 * Post a DM to a Slack user.
 *
 * Returns `{ revoked: true }` when Slack reports a terminal auth error so
 * the caller can mark the user's connection as revoked. Returns
 * `{ revoked: false }` on success or transient failure.
 */
export async function sendSlackDm(
  slackUserId: string,
  payload: SlackDmPayload
): Promise<{ revoked: boolean }> {
  const client = getClient();
  if (!client) {
    console.warn("SLACK_BOT_TOKEN is not set, skipping Slack DM.");
    return { revoked: false };
  }

  try {
    await client.chat.postMessage({
      channel: slackUserId,
      text: payload.text,
      blocks: payload.blocks,
    });
    return { revoked: false };
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "data" in err
        ? (err as { data?: { error?: string } }).data?.error
        : undefined;
    if (code && REVOKED_ERRORS.has(code)) {
      return { revoked: true };
    }
    console.error(`Failed to send Slack DM to ${slackUserId}: ${String(err)}`);
    return { revoked: false };
  }
}

/**
 * Mark a user's Slack connection as revoked so the settings UI can prompt
 * them to reconnect. Called when `sendSlackDm` returns `{ revoked: true }`.
 */
export async function markSlackConnectionRevoked(
  userId: string
): Promise<void> {
  try {
    await db
      .update(slackConnections)
      .set({ revokedAt: new Date() })
      .where(eq(slackConnections.userId, userId));
  } catch (err) {
    console.error(
      `Failed to mark Slack connection revoked for user ${userId}: ${String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Block Kit message builders
// ---------------------------------------------------------------------------

export function buildRunCreatedBlocks(opts: {
  instrumentDisplayName: string;
  runDisplayId: string;
  runUrl: string;
}): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*New run on ${opts.instrumentDisplayName}*\nRun \`${opts.runDisplayId}\` has been reported.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View in Data Hub" },
          url: opts.runUrl,
        },
      ],
    },
  ];
}

export function buildCommentBlocks(opts: {
  actorDisplayName: string;
  instrumentDisplayName: string;
  runDisplayId: string;
  commentPreview: string;
  runUrl: string;
  type: "comment_attributed" | "comment_participated";
}): (Block | KnownBlock)[] {
  const action =
    opts.type === "comment_attributed"
      ? `*${opts.actorDisplayName}* mentioned you in a run you ran`
      : `*${opts.actorDisplayName}* commented on a run you participated in`;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${action} on *${opts.instrumentDisplayName}* (\`${opts.runDisplayId}\`)\n> ${opts.commentPreview.replace(/\n/g, "\n> ")}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View comment" },
          url: opts.runUrl,
        },
      ],
    },
  ];
}
