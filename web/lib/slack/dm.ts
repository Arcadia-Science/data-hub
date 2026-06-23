// Sends personal Slack DMs via the shared org bot token.
//
// The bot posts to each recipient's Slack member ID directly — Slack
// auto-opens the DM channel when `channel` is a user ID with `chat:write`.
// No per-user token is stored; the shared `SLACK_BOT_TOKEN` env var is the
// only credential. Like the existing `sendSlackMessage` webhook helper, if
// the token is absent the function is a no-op so local dev and tests can opt
// out cleanly.
//
// Failures are classified, never thrown — DMs are a side-channel and must not
// break the mutation that triggered the notification. The classification
// matters because every DM uses the *shared* bot token: a token-level failure
// is global and says nothing about any one recipient, so it must not revoke a
// user's connection (which would falsely tell them to reconnect when only an
// admin can fix the token). Error strings are from Slack's `chat.postMessage`
// reference: https://api.slack.com/methods/chat.postMessage.

import type { Block, KnownBlock } from "@slack/web-api";
import { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { slackConnections } from "@/lib/db/schema";

// The recipient can't be DM'd: their stored member ID no longer resolves to a
// DM channel (left the workspace, deactivated). Revoke just this connection.
const USER_UNREACHABLE_ERRORS = new Set(["channel_not_found"]);

// The shared bot token / app install is broken. Affects every recipient, so
// these must never revoke an individual connection.
const BOT_TOKEN_ERRORS = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
  "missing_scope",
  "not_allowed_token_type",
]);

function extractSlackErrorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data?.error
    : undefined;
}

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

export type SlackDmResult =
  | { status: "sent" }
  // The bot token is dead; the whole batch will fail the same way.
  | { status: "bot_token_invalid" }
  // This recipient is gone; their connection should be revoked.
  | { status: "user_unreachable" }
  // Missing token, rate limit, server error — retry-able, no action.
  | { status: "transient" };

async function sendSlackDm(
  slackUserId: string,
  payload: SlackDmPayload
): Promise<SlackDmResult> {
  const client = getClient();
  if (!client) {
    return { status: "transient" };
  }

  try {
    await client.chat.postMessage({
      channel: slackUserId,
      text: payload.text,
      blocks: payload.blocks,
    });
    return { status: "sent" };
  } catch (err: unknown) {
    const code = extractSlackErrorCode(err);
    if (code && USER_UNREACHABLE_ERRORS.has(code)) {
      return { status: "user_unreachable" };
    }
    if (code && BOT_TOKEN_ERRORS.has(code)) {
      return { status: "bot_token_invalid" };
    }
    console.error(`Failed to send Slack DM to ${slackUserId}: ${String(err)}`);
    return { status: "transient" };
  }
}

export interface SlackDmJob {
  payload: SlackDmPayload;
  slackUserId: string;
  userId: string;
}

/**
 * Deliver a batch of DMs concurrently and react to per-recipient vs global
 * failures. Only `user_unreachable` revokes a connection; a dead bot token is
 * logged once for ops and leaves every connection intact.
 */
export async function deliverSlackDms(jobs: SlackDmJob[]): Promise<void> {
  if (jobs.length === 0) {
    return;
  }

  let botTokenInvalid = false;
  await Promise.all(
    jobs.map(async (job) => {
      const result = await sendSlackDm(job.slackUserId, job.payload);
      if (result.status === "user_unreachable") {
        await markSlackConnectionRevoked(job.userId);
      } else if (result.status === "bot_token_invalid") {
        botTokenInvalid = true;
      }
    })
  );

  if (botTokenInvalid) {
    console.error(
      "Slack bot token rejected; DMs skipped until the app is reinstalled or the token is rotated."
    );
  }
}

async function markSlackConnectionRevoked(userId: string): Promise<void> {
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
  const summary =
    opts.type === "comment_attributed"
      ? `*${opts.actorDisplayName}* commented on a run you ran on *${opts.instrumentDisplayName}* (\`${opts.runDisplayId}\`)`
      : `*${opts.actorDisplayName}* commented on *${opts.instrumentDisplayName}* (\`${opts.runDisplayId}\`), a run you've commented on`;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${summary}\n> ${opts.commentPreview.replace(/\n/g, "\n> ")}`,
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
