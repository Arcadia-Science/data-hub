import { formatInTimeZone } from "date-fns-tz";
import type { Actor } from "@/lib/api/actor";
import type { CommentFeedItem } from "@/lib/api/run-comments";
import { formatRelativeTime } from "@/lib/utils";

export interface CommentRowModel {
  /** A person, or the token that posted the comment through the API. */
  author: Actor;
  body: string;
  created_at: string;
  id: string;
  run: CommentFeedItem["run"];
  /** e.g. "3 days ago", for lists without day headings. */
  timeAgo: string;
  timeFull: string;
  /** e.g. "5:02 PM", for lists grouped under day headings. */
  timeOfDay: string;
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
    timeOfDay: formatInTimeZone(comment.created_at, timeZone, "h:mm a"),
    timeAgo: formatRelativeTime(comment.created_at),
    author: comment.author,
    run: comment.run,
  };
}

export function commentCountLabel(count: number): string {
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}
