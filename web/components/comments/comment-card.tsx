import { RelativeTime } from "@/components/dashboard/relative-time";
import { CommentMarkdownPreview } from "@/components/runs/comment-markdown";
import type { CommentFeedItem } from "@/lib/api/run-comments";
import { CommentAuthor, CommentOverlayLink } from "./comment-parts";

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
        <RelativeTime date={comment.created_at.toISOString()} />
      </CommentAuthor>
      {/* `line-clamp` doesn't clip block children such as code blocks and
          tables, so the preview is a fixed three-line window. The mask fades
          the cut so a heading or code block isn't sliced through the glyphs. */}
      <div className="max-h-[4.3rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]">
        <CommentMarkdownPreview body={comment.body} />
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
