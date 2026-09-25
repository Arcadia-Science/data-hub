import { formatInTimeZone } from "date-fns-tz";
import type { CommentFeedItem } from "@/lib/api/run-comments";
import type { UserAvatarUser } from "@/lib/avatar-color";

export interface CommentRowModel {
  body: string;
  created_at: string;
  id: string;
  run: CommentFeedItem["run"];
  timeFull: string;
  timeLabel: string;
  user: UserAvatarUser;
}

export function toCommentRow(
  comment: CommentFeedItem,
  timeZone: string
): CommentRowModel {
  const createdAt = comment.created_at.toISOString();
  return {
    id: comment.id,
    body: comment.body,
    created_at: createdAt,
    timeFull: formatInTimeZone(
      comment.created_at,
      timeZone,
      "MMM d, yyyy h:mm a"
    ),
    timeLabel: formatInTimeZone(comment.created_at, timeZone, "h:mm a"),
    user: {
      avatarUrl: comment.user.avatarUrl,
      displayName: comment.user.displayName,
      initials: comment.user.initials,
      userId: comment.user.id,
    },
    run: comment.run,
  };
}

export function commentCountLabel(count: number): string {
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}
