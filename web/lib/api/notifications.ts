import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type InstrumentType,
  instrumentNotificationSubscriptions,
  instrumentRuns,
  instruments,
  notificationPreferences,
  notifications,
  runAttributions,
  runComments,
  slackConnections,
  users,
} from "@/lib/db/schema";
import {
  buildCommentBlocks,
  buildRunCreatedBlocks,
  markSlackConnectionRevoked,
  sendSlackDm,
} from "@/lib/slack/dm";
import { toInitials } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Notifications — in-app event delivery for instrument runs and run comments.
//
// Three trigger types live in `notification_type`:
//   - `run_created`           : a new run was created on a subscribed
//                                instrument; emitted to every user with a
//                                `instrument_notification_subscriptions`
//                                row that has `enabled = true` AND whose
//                                `notification_preferences.runsAllMuted`
//                                is false.
//   - `comment_attributed`    : a run-attributee received a new comment.
//   - `comment_participated`  : a prior commenter received a new comment.
//
// All preference-mutating routes are session-only — these endpoints are
// personal-UX, never invoked by PATs, so we don't add a scope.
// ---------------------------------------------------------------------------

export interface NotificationPreferencesDto {
  commentsAttributedEnabled: boolean;
  commentsParticipatedEnabled: boolean;
  // In-app delivery
  runsAllMuted: boolean;
  slackCommentsAttributedEnabled: boolean;
  slackCommentsParticipatedEnabled: boolean;
  // Slack delivery — independent of in-app; all default false until the user
  // connects Slack (at which point the OAuth callback flips these to true).
  slackRunsEnabled: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferencesDto = {
  runsAllMuted: false,
  commentsAttributedEnabled: true,
  commentsParticipatedEnabled: true,
  slackRunsEnabled: false,
  slackCommentsAttributedEnabled: false,
  slackCommentsParticipatedEnabled: false,
};

// ---------------------------------------------------------------------------
// Preferences: SELECT-only on the read path with a `DEFAULT_PREFERENCES`
// fallback for users who haven't materialized a row yet. `updatePreferences`
// does its own upsert on write, so we never need to insert from the read
// side just to make the form render — keeping the read at one RTT.
// ---------------------------------------------------------------------------

export async function getPreferences(
  userId: string
): Promise<NotificationPreferencesDto> {
  const [row] = await db
    .select({
      runsAllMuted: notificationPreferences.runsAllMuted,
      commentsAttributedEnabled:
        notificationPreferences.commentsAttributedEnabled,
      commentsParticipatedEnabled:
        notificationPreferences.commentsParticipatedEnabled,
      slackRunsEnabled: notificationPreferences.slackRunsEnabled,
      slackCommentsAttributedEnabled:
        notificationPreferences.slackCommentsAttributedEnabled,
      slackCommentsParticipatedEnabled:
        notificationPreferences.slackCommentsParticipatedEnabled,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);

  return row ?? DEFAULT_PREFERENCES;
}

export async function updatePreferences(
  userId: string,
  patch: Partial<NotificationPreferencesDto>
): Promise<NotificationPreferencesDto> {
  // Map DTO field names to the DB column names used by Drizzle. The
  // `values()` call on a fresh insert also uses these column references so
  // the column name mapping only needs to live in one place.
  const dbPatch: Partial<{
    runsAllMuted: boolean;
    commentsAttributedEnabled: boolean;
    commentsParticipatedEnabled: boolean;
    slackRunsEnabled: boolean;
    slackCommentsAttributedEnabled: boolean;
    slackCommentsParticipatedEnabled: boolean;
    updatedAt: Date;
  }> = {};

  if (patch.runsAllMuted !== undefined) {
    dbPatch.runsAllMuted = patch.runsAllMuted;
  }
  if (patch.commentsAttributedEnabled !== undefined) {
    dbPatch.commentsAttributedEnabled = patch.commentsAttributedEnabled;
  }
  if (patch.commentsParticipatedEnabled !== undefined) {
    dbPatch.commentsParticipatedEnabled = patch.commentsParticipatedEnabled;
  }
  if (patch.slackRunsEnabled !== undefined) {
    dbPatch.slackRunsEnabled = patch.slackRunsEnabled;
  }
  if (patch.slackCommentsAttributedEnabled !== undefined) {
    dbPatch.slackCommentsAttributedEnabled =
      patch.slackCommentsAttributedEnabled;
  }
  if (patch.slackCommentsParticipatedEnabled !== undefined) {
    dbPatch.slackCommentsParticipatedEnabled =
      patch.slackCommentsParticipatedEnabled;
  }

  await db
    .insert(notificationPreferences)
    .values({ userId, ...dbPatch })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: { ...dbPatch, updatedAt: new Date() },
    });

  return getPreferences(userId);
}

// ---------------------------------------------------------------------------
// Per-instrument subscriptions: left-joined against `instruments` so the
// settings page sees the full instrument catalogue with each row's current
// `enabled` state (missing row → disabled).
// ---------------------------------------------------------------------------

export interface InstrumentSubscriptionRow {
  displayName: string;
  enabled: boolean;
  instrumentId: string;
}

export async function listInstrumentSubscriptions(
  userId: string
): Promise<InstrumentSubscriptionRow[]> {
  const rows = await db
    .select({
      instrumentId: instruments.id,
      displayName: instruments.displayName,
      enabled: instrumentNotificationSubscriptions.enabled,
    })
    .from(instruments)
    .leftJoin(
      instrumentNotificationSubscriptions,
      and(
        eq(instrumentNotificationSubscriptions.instrumentId, instruments.id),
        eq(instrumentNotificationSubscriptions.userId, userId)
      )
    )
    .orderBy(asc(instruments.displayName));

  return rows.map((r) => ({
    instrumentId: r.instrumentId,
    displayName: r.displayName,
    enabled: r.enabled ?? false,
  }));
}

export async function setInstrumentSubscription(
  userId: string,
  instrumentId: string,
  enabled: boolean
): Promise<void> {
  await db
    .insert(instrumentNotificationSubscriptions)
    .values({ userId, instrumentId, enabled })
    .onConflictDoUpdate({
      target: [
        instrumentNotificationSubscriptions.userId,
        instrumentNotificationSubscriptions.instrumentId,
      ],
      set: { enabled, updatedAt: new Date() },
    });
}

// ---------------------------------------------------------------------------
// Listing notifications for the bell popover. Joins the run + instrument +
// actor user once so the wire shape is render-ready and the popover doesn't
// need follow-up requests.
// ---------------------------------------------------------------------------

// Hard cap on the comment-body snippet returned in the popover payload —
// the full body is never needed for the bell list and we don't want
// kilobyte-sized markdown blobs piggy-backing on every poll.
const COMMENT_BODY_PREVIEW_LENGTH = 240;

export interface NotificationDto {
  actor: {
    id: string;
    displayName: string;
    initials: string;
    avatarUrl: string | null;
  } | null;
  // Truncated markdown body of the originating comment — only populated
  // when `commentId` is set. NULL for `run_created` rows and for comment
  // rows whose comment has been soft-deleted.
  commentBody: string | null;
  commentId: string | null;
  createdAt: Date;
  id: string;
  instrumentDisplayName: string;
  // Natural keys for linking — `/instruments/:instrumentId/runs/:runId` is
  // what the row navigates to.
  instrumentId: string;
  // Surfaced so the bell can render a type-specific icon for grouped
  // `run_created` rows (microscope / gel doc / plate reader).
  instrumentType: InstrumentType;
  readAt: Date | null;
  runDisplayId: string;
  runId: string;
  type: "run_created" | "comment_attributed" | "comment_participated";
}

export async function listNotifications(
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {}
): Promise<NotificationDto[]> {
  const limit = opts.limit ?? 20;
  const actor = aliasedTable(users, "actor");

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      runId: instrumentRuns.id,
      runDisplayId: instrumentRuns.runId,
      instrumentId: instrumentRuns.instrumentId,
      instrumentDisplayName: instruments.displayName,
      instrumentType: instruments.instrumentType,
      commentId: notifications.commentId,
      // Soft-deleted comments are surfaced as `null` body via the join
      // filter below; the row still exists so the user can navigate to
      // the run, the popover just renders without a preview.
      commentBody: runComments.body,
      actorId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      actorImage: actor.image,
    })
    .from(notifications)
    .innerJoin(instrumentRuns, eq(instrumentRuns.id, notifications.runId))
    .innerJoin(instruments, eq(instruments.id, instrumentRuns.instrumentId))
    .leftJoin(actor, eq(actor.id, notifications.actorUserId))
    .leftJoin(
      runComments,
      and(
        eq(runComments.id, notifications.commentId),
        isNull(runComments.deletedAt)
      )
    )
    .where(
      opts.unreadOnly
        ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
        : eq(notifications.userId, userId)
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  return rows.map((row) => {
    const actorDisplayName = row.actorId
      ? (row.actorName ?? row.actorEmail ?? "Unknown")
      : null;
    const previewBody =
      row.commentBody && row.commentBody.length > COMMENT_BODY_PREVIEW_LENGTH
        ? `${row.commentBody.slice(0, COMMENT_BODY_PREVIEW_LENGTH).trimEnd()}…`
        : row.commentBody;
    return {
      id: row.id,
      type: row.type,
      createdAt: row.createdAt,
      readAt: row.readAt,
      runId: row.runId,
      runDisplayId: row.runDisplayId,
      instrumentId: row.instrumentId,
      instrumentDisplayName: row.instrumentDisplayName,
      instrumentType: row.instrumentType,
      commentId: row.commentId,
      commentBody: previewBody,
      actor:
        row.actorId && actorDisplayName
          ? {
              id: row.actorId,
              displayName: actorDisplayName,
              initials: toInitials(actorDisplayName),
              avatarUrl: row.actorImage,
            }
          : null,
    };
  });
}

export async function countUnread(userId: string): Promise<number> {
  // Hits the partial `idx_notifications_user_id_unread` index; the count
  // never has to scan read rows.
  const [row] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.count ?? 0;
}

export async function markRead(userId: string, ids?: string[]): Promise<void> {
  if (ids && ids.length === 0) {
    return;
  }
  const now = new Date();
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(
      ids
        ? and(
            eq(notifications.userId, userId),
            inArray(notifications.id, ids),
            isNull(notifications.readAt)
          )
        : and(eq(notifications.userId, userId), isNull(notifications.readAt))
    );
}

// ---------------------------------------------------------------------------
// Fan-out helpers — invoked from inside `after(...)` hooks on the run-create
// and comment-create routes so the writing route can return immediately.
//
// In-app and Slack are **independent delivery channels** that share the same
// candidacy logic (who cares about this event). For each candidate we decide
// separately:
//   (a) Insert a `notifications` row  — if the user's in-app toggle is on.
//   (b) Send a Slack DM               — if the user has a live Slack
//                                       connection AND the Slack toggle is on.
//
// A user can therefore receive a type via Slack only (no bell row), in-app
// only, both, or neither. Failures in either channel are swallowed and logged
// — a notification outage must never fail the triggering mutation, and a
// Slack failure must never suppress the in-app insert (and vice-versa).
// ---------------------------------------------------------------------------

export async function notifyRunCreated(input: {
  runInternalId: string;
  instrumentId: string;
  // The following are needed to build Slack DM messages. When omitted
  // (e.g. in library-level tests that don't test Slack delivery), Slack
  // DMs are silently skipped even if a user has a live connection.
  instrumentDisplayName?: string;
  runDisplayId?: string;
  origin?: string;
}): Promise<void> {
  try {
    // Candidates: every user with an enabled subscription for this instrument.
    // We pull all channel-routing columns in one join so a single query covers
    // both in-app and Slack delivery decisions.
    const candidates = await db
      .select({
        userId: instrumentNotificationSubscriptions.userId,
        // In-app: muted when `runs_all_muted` is true.
        runsAllMuted: notificationPreferences.runsAllMuted,
        // Slack: enabled when connected (non-revoked) AND toggle is on.
        slackUserId: slackConnections.slackUserId,
        slackRunsEnabled: notificationPreferences.slackRunsEnabled,
        slackRevokedAt: slackConnections.revokedAt,
      })
      .from(instrumentNotificationSubscriptions)
      .leftJoin(
        notificationPreferences,
        eq(
          notificationPreferences.userId,
          instrumentNotificationSubscriptions.userId
        )
      )
      .leftJoin(
        slackConnections,
        eq(slackConnections.userId, instrumentNotificationSubscriptions.userId)
      )
      .where(
        and(
          eq(
            instrumentNotificationSubscriptions.instrumentId,
            input.instrumentId
          ),
          eq(instrumentNotificationSubscriptions.enabled, true)
        )
      );

    if (candidates.length === 0) {
      return;
    }

    const inAppRows = candidates
      .filter(
        // `coalesce(runsAllMuted, false)` so missing pref row → not muted.
        (c) => !c.runsAllMuted
      )
      .map((c) => ({
        userId: c.userId,
        type: "run_created" as const,
        runId: input.runInternalId,
      }));

    const slackCandidates = candidates.filter(
      (c) => c.slackUserId && !c.slackRevokedAt && (c.slackRunsEnabled ?? false)
    );

    // Insert in-app rows first; Slack DMs fire after so a Slack outage
    // never delays or blocks the bell badge update.
    if (inAppRows.length > 0) {
      await db.insert(notifications).values(inAppRows);
    }

    const { origin, runDisplayId, instrumentDisplayName } = input;
    if (
      slackCandidates.length > 0 &&
      origin &&
      runDisplayId &&
      instrumentDisplayName
    ) {
      const runUrl = `${origin}/instruments/${input.instrumentId}/runs/${encodeURIComponent(runDisplayId)}`;
      await Promise.all(
        slackCandidates.map(async (c) => {
          const slackUserId = c.slackUserId ?? "";
          const result = await sendSlackDm(slackUserId, {
            text: `New run on *${instrumentDisplayName}*: \`${runDisplayId}\``,
            blocks: buildRunCreatedBlocks({
              instrumentDisplayName,
              runDisplayId,
              runUrl,
            }),
          });
          if (result.revoked) {
            await markSlackConnectionRevoked(c.userId);
          }
        })
      );
    }
  } catch (err) {
    console.error("notifyRunCreated failed", err);
  }
}

export async function notifyComment(input: {
  runInternalId: string;
  commentId: string;
  authorUserId: string;
  // The following are needed to build Slack DM messages. When omitted
  // (e.g. in library-level tests), Slack DMs are silently skipped.
  authorDisplayName?: string;
  instrumentId?: string;
  instrumentDisplayName?: string;
  runDisplayId?: string;
  commentBody?: string;
  origin?: string;
}): Promise<void> {
  try {
    // Resolve the two candidate sets independently (attributed wins over
    // participated on overlap). Each branch pulls all channel-routing columns
    // in one join — candidacy is independent of channel toggles so we can
    // apply per-channel gates in JS after the query.
    const [attributedRows, participatedRows] = await Promise.all([
      db
        .select({
          userId: runAttributions.userId,
          commentsAttributedEnabled:
            notificationPreferences.commentsAttributedEnabled,
          slackUserId: slackConnections.slackUserId,
          slackCommentsAttributedEnabled:
            notificationPreferences.slackCommentsAttributedEnabled,
          slackRevokedAt: slackConnections.revokedAt,
        })
        .from(runAttributions)
        .leftJoin(
          notificationPreferences,
          eq(notificationPreferences.userId, runAttributions.userId)
        )
        .leftJoin(
          slackConnections,
          eq(slackConnections.userId, runAttributions.userId)
        )
        .where(
          and(
            eq(runAttributions.runId, input.runInternalId),
            sql`${runAttributions.userId} <> ${input.authorUserId}`
          )
        ),
      db
        .selectDistinct({
          userId: runComments.userId,
          commentsParticipatedEnabled:
            notificationPreferences.commentsParticipatedEnabled,
          slackUserId: slackConnections.slackUserId,
          slackCommentsParticipatedEnabled:
            notificationPreferences.slackCommentsParticipatedEnabled,
          slackRevokedAt: slackConnections.revokedAt,
        })
        .from(runComments)
        .leftJoin(
          notificationPreferences,
          eq(notificationPreferences.userId, runComments.userId)
        )
        .leftJoin(
          slackConnections,
          eq(slackConnections.userId, runComments.userId)
        )
        .where(
          and(
            eq(runComments.runId, input.runInternalId),
            sql`${runComments.userId} <> ${input.authorUserId}`,
            isNull(runComments.deletedAt)
          )
        ),
    ]);

    // Attributed wins on overlap: a user already in `attributedRows` is
    // skipped from `participatedRows` to avoid double-delivery.
    const attributedSet = new Set(attributedRows.map((r) => r.userId));
    const participatedOnly = participatedRows.filter(
      (r) => !attributedSet.has(r.userId)
    );

    // --- In-app delivery (independent of Slack) ---
    const inAppRows = [
      ...attributedRows
        .filter((r) => r.commentsAttributedEnabled !== false)
        .map((r) => ({
          userId: r.userId,
          type: "comment_attributed" as const,
          runId: input.runInternalId,
          commentId: input.commentId,
          actorUserId: input.authorUserId,
        })),
      ...participatedOnly
        .filter((r) => r.commentsParticipatedEnabled !== false)
        .map((r) => ({
          userId: r.userId,
          type: "comment_participated" as const,
          runId: input.runInternalId,
          commentId: input.commentId,
          actorUserId: input.authorUserId,
        })),
    ];

    if (inAppRows.length > 0) {
      await db.insert(notifications).values(inAppRows);
    }

    // --- Slack delivery (independent of in-app) ---
    // Skip entirely when the route didn't supply the fields needed to build
    // the DM (e.g. library-level test invocations).
    const {
      origin: dmOrigin,
      instrumentId: dmInstrumentId,
      runDisplayId: dmRunDisplayId,
      instrumentDisplayName: dmInstrumentDisplayName,
      authorDisplayName: dmAuthorDisplayName,
      commentBody: dmCommentBody,
    } = input;

    if (
      dmOrigin &&
      dmInstrumentId &&
      dmRunDisplayId &&
      dmInstrumentDisplayName &&
      dmAuthorDisplayName &&
      dmCommentBody !== undefined
    ) {
      const runUrl = `${dmOrigin}/instruments/${dmInstrumentId}/runs/${encodeURIComponent(dmRunDisplayId)}#comment-${input.commentId}`;
      const commentPreview =
        dmCommentBody.length > 240
          ? `${dmCommentBody.slice(0, 240).trimEnd()}…`
          : dmCommentBody;

      const slackJobs: Array<{
        userId: string;
        slackUserId: string;
        type: "comment_attributed" | "comment_participated";
      }> = [
        ...attributedRows
          .filter(
            (r) =>
              r.slackUserId &&
              !r.slackRevokedAt &&
              (r.slackCommentsAttributedEnabled ?? false)
          )
          .map((r) => ({
            userId: r.userId,
            slackUserId: r.slackUserId ?? "",
            type: "comment_attributed" as const,
          })),
        ...participatedOnly
          .filter(
            (r) =>
              r.slackUserId &&
              !r.slackRevokedAt &&
              (r.slackCommentsParticipatedEnabled ?? false)
          )
          .map((r) => ({
            userId: r.userId,
            slackUserId: r.slackUserId ?? "",
            type: "comment_participated" as const,
          })),
      ];

      if (slackJobs.length > 0) {
        await Promise.all(
          slackJobs.map(async (job) => {
            const result = await sendSlackDm(job.slackUserId, {
              text:
                job.type === "comment_attributed"
                  ? `${dmAuthorDisplayName} mentioned you in a run you ran on *${dmInstrumentDisplayName}*`
                  : `${dmAuthorDisplayName} commented on a run you participated in on *${dmInstrumentDisplayName}*`,
              blocks: buildCommentBlocks({
                actorDisplayName: dmAuthorDisplayName,
                instrumentDisplayName: dmInstrumentDisplayName,
                runDisplayId: dmRunDisplayId,
                commentPreview,
                runUrl,
                type: job.type,
              }),
            });
            if (result.revoked) {
              await markSlackConnectionRevoked(job.userId);
            }
          })
        );
      }
    }
  } catch (err) {
    console.error("notifyComment failed", err);
  }
}
