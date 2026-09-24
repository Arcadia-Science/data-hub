import { RelativeTime } from "@/components/dashboard/relative-time";
import { CommentMarkdown } from "@/components/runs/comment-markdown";
import type { CommentFeedItem } from "@/lib/api/run-comments";
import { CommentAuthor, CommentOverlayLink } from "./comment-parts";

function toIsoString(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

export function CommentCard({ comment }: { comment: CommentFeedItem }) {
  return (
    <article className="relative flex h-full flex-col gap-3 rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/10 transition-colors hover:bg-muted/40">
      <CommentAuthor
        user={{
          userId: comment.user.id,
          displayName: comment.user.displayName,
          initials: comment.user.initials,
          avatarUrl: comment.user.avatarUrl,
        }}
      >
        <RelativeTime date={toIsoString(comment.created_at)} />
      </CommentAuthor>
      {/* `line-clamp` doesn't clip block children such as code blocks and
          tables, so the preview is a fixed three-line window instead. */}
      <div className="max-h-[4.3rem] overflow-hidden">
        <CommentMarkdown body={comment.body} />
      </div>
      <div className="mt-auto border-border border-t border-dashed pt-3">
        <CommentOverlayLink
          commentId={comment.id}
          instrumentId={comment.run.instrumentId}
          instrumentName={comment.run.instrumentDisplayName}
          runId={comment.run.runId}
        />
      </div>
    </article>
  );
}
