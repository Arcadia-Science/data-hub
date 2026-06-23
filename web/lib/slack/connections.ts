// Data-access helpers for `slack_connections`.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notificationPreferences, slackConnections } from "@/lib/db/schema";

export interface SlackConnectionDto {
  connectedAt: Date;
  revokedAt: Date | null;
  slackTeamId: string;
  slackTeamName: string | null;
  slackUserId: string;
}

export async function getSlackConnection(
  userId: string
): Promise<SlackConnectionDto | null> {
  const [row] = await db
    .select({
      slackUserId: slackConnections.slackUserId,
      slackTeamId: slackConnections.slackTeamId,
      slackTeamName: slackConnections.slackTeamName,
      connectedAt: slackConnections.connectedAt,
      revokedAt: slackConnections.revokedAt,
    })
    .from(slackConnections)
    .where(eq(slackConnections.userId, userId))
    .limit(1);

  return row ?? null;
}

export async function upsertSlackConnection(
  userId: string,
  data: {
    slackUserId: string;
    slackTeamId: string;
    slackTeamName: string | null;
  }
): Promise<void> {
  await db
    .insert(slackConnections)
    .values({
      userId,
      slackUserId: data.slackUserId,
      slackTeamId: data.slackTeamId,
      slackTeamName: data.slackTeamName,
      connectedAt: new Date(),
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: slackConnections.userId,
      set: {
        slackUserId: data.slackUserId,
        slackTeamId: data.slackTeamId,
        slackTeamName: data.slackTeamName,
        connectedAt: new Date(),
        revokedAt: null,
      },
    });

  // On (re)connect, opt the user in to all three Slack notification types.
  await setAllSlackPrefs(userId, true);
}

export async function deleteSlackConnection(userId: string): Promise<void> {
  await db.delete(slackConnections).where(eq(slackConnections.userId, userId));

  // Disable Slack toggles so stale prefs don't accidentally fire if the user
  // reconnects a different account later and the previous toggles would
  // otherwise be inherited.
  await setAllSlackPrefs(userId, false);
}

async function setAllSlackPrefs(
  userId: string,
  enabled: boolean
): Promise<void> {
  await db
    .insert(notificationPreferences)
    .values({
      userId,
      slackRunsEnabled: enabled,
      slackCommentsAttributedEnabled: enabled,
      slackCommentsParticipatedEnabled: enabled,
    })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: {
        slackRunsEnabled: enabled,
        slackCommentsAttributedEnabled: enabled,
        slackCommentsParticipatedEnabled: enabled,
        updatedAt: new Date(),
      },
    });
}
