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
  users,
} from "@/lib/db/schema";
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

export type NotificationPreferencesDto = {
  runsAllMuted: boolean;
  commentsAttributedEnabled: boolean;
  commentsParticipatedEnabled: boolean;
};

const DEFAULT_PREFERENCES: NotificationPreferencesDto = {
  runsAllMuted: false,
  commentsAttributedEnabled: true,
  commentsParticipatedEnabled: true,
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
  // Make sure the row exists so the subsequent UPDATE has something to
  // touch — keeps the function valid as a first-write entry point.
  await db
    .insert(notificationPreferences)
    .values({ userId, ...patch })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: { ...patch, updatedAt: new Date() },
    });

  return getPreferences(userId);
}

// ---------------------------------------------------------------------------
// Per-instrument subscriptions: left-joined against `instruments` so the
// settings page sees the full instrument catalogue with each row's current
// `enabled` state (missing row → disabled).
// ---------------------------------------------------------------------------

export type InstrumentSubscriptionRow = {
  instrumentId: string;
  displayName: string;
  enabled: boolean;
};

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

export type NotificationDto = {
  id: string;
  type: "run_created" | "comment_attributed" | "comment_participated";
  createdAt: Date;
  readAt: Date | null;
  runId: string;
  // Natural keys for linking — `/instruments/:instrumentId/runs/:runId` is
  // what the row navigates to.
  instrumentId: string;
  runDisplayId: string;
  instrumentDisplayName: string;
  // Surfaced so the bell can render a type-specific icon for grouped
  // `run_created` rows (microscope / gel doc / plate reader).
  instrumentType: InstrumentType;
  commentId: string | null;
  // Truncated markdown body of the originating comment — only populated
  // when `commentId` is set. NULL for `run_created` rows and for comment
  // rows whose comment has been soft-deleted.
  commentBody: string | null;
  actor: {
    id: string;
    displayName: string;
    initials: string;
    avatarUrl: string | null;
  } | null;
};

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
// Each helper performs a single targeted SELECT to compute recipients, then
// a single bulk INSERT. Failures are swallowed and logged: a notification
// outage must never fail the underlying mutation.
// ---------------------------------------------------------------------------

export async function notifyRunCreated(input: {
  runInternalId: string;
  instrumentId: string;
}): Promise<void> {
  try {
    // Recipients: every user whose subscription for this instrument is
    // enabled AND whose master `runs_all_muted` is false (or absent —
    // missing row implies defaults i.e. master not muted).
    const recipients = await db
      .select({
        userId: instrumentNotificationSubscriptions.userId,
      })
      .from(instrumentNotificationSubscriptions)
      .leftJoin(
        notificationPreferences,
        eq(
          notificationPreferences.userId,
          instrumentNotificationSubscriptions.userId
        )
      )
      .where(
        and(
          eq(
            instrumentNotificationSubscriptions.instrumentId,
            input.instrumentId
          ),
          eq(instrumentNotificationSubscriptions.enabled, true),
          // `coalesce(..., false)` so the master flag missing entirely
          // (no preferences row yet) is treated as not-muted.
          sql`coalesce(${notificationPreferences.runsAllMuted}, false) = false`
        )
      );

    if (recipients.length === 0) {
      return;
    }

    await db.insert(notifications).values(
      recipients.map((r) => ({
        userId: r.userId,
        type: "run_created" as const,
        runId: input.runInternalId,
      }))
    );
  } catch (err) {
    console.error("notifyRunCreated failed", err);
  }
}

export async function notifyComment(input: {
  runInternalId: string;
  commentId: string;
  authorUserId: string;
}): Promise<void> {
  try {
    // Build the recipient set in two SELECTs that we union in JS so the
    // attributed→participated precedence is enforced cleanly without a
    // PostgreSQL-only DISTINCT ON. Each branch is independently gated on
    // the user's own `comments_*_enabled` toggle and skips the comment
    // author themselves.
    const [attributedRows, participatedRows] = await Promise.all([
      db
        .select({ userId: runAttributions.userId })
        .from(runAttributions)
        .leftJoin(
          notificationPreferences,
          eq(notificationPreferences.userId, runAttributions.userId)
        )
        .where(
          and(
            eq(runAttributions.runId, input.runInternalId),
            sql`${runAttributions.userId} <> ${input.authorUserId}`,
            sql`coalesce(${notificationPreferences.commentsAttributedEnabled}, true) = true`
          )
        ),
      db
        .selectDistinct({ userId: runComments.userId })
        .from(runComments)
        .leftJoin(
          notificationPreferences,
          eq(notificationPreferences.userId, runComments.userId)
        )
        .where(
          and(
            eq(runComments.runId, input.runInternalId),
            sql`${runComments.userId} <> ${input.authorUserId}`,
            isNull(runComments.deletedAt),
            sql`coalesce(${notificationPreferences.commentsParticipatedEnabled}, true) = true`
          )
        ),
    ]);

    // Attributed wins on overlap so the user only sees one row per
    // (recipient, comment) and the type carries the strongest signal.
    const attributedSet = new Set(attributedRows.map((r) => r.userId));
    const participatedOnly = participatedRows
      .map((r) => r.userId)
      .filter((id) => !attributedSet.has(id));

    const rows = [
      ...attributedRows.map((r) => ({
        userId: r.userId,
        type: "comment_attributed" as const,
        runId: input.runInternalId,
        commentId: input.commentId,
        actorUserId: input.authorUserId,
      })),
      ...participatedOnly.map((userId) => ({
        userId,
        type: "comment_participated" as const,
        runId: input.runInternalId,
        commentId: input.commentId,
        actorUserId: input.authorUserId,
      })),
    ];

    if (rows.length === 0) {
      return;
    }

    await db.insert(notifications).values(rows);
  } catch (err) {
    console.error("notifyComment failed", err);
  }
}
