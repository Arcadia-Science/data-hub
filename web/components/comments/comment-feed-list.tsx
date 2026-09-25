import { CommentMarkdown } from "@/components/runs/comment-markdown";
import { Timestamp } from "@/components/timestamp";
import { Skeleton } from "@/components/ui/skeleton";
import type { CommentFeedItem } from "@/lib/api/run-comments";
import type { CommentDaySection } from "@/lib/comments/group-by-day";
import { CommentAuthor, CommentRunLink } from "./comment-parts";

export interface CommentFeedEntry extends CommentFeedItem {
  createdAtIso: string;
  timeFull: string;
  timeLabel: string;
}

function CommentFeedRow({ comment }: { comment: CommentFeedEntry }) {
  return (
    <li>
      <article className="relative flex flex-col gap-2 border-border border-b py-4 transition-colors hover:bg-muted/40">
        <CommentAuthor
          user={{
            userId: comment.user.id,
            displayName: comment.user.displayName,
            initials: comment.user.initials,
            avatarUrl: comment.user.avatarUrl,
          }}
        >
          <Timestamp
            dateTime={comment.createdAtIso}
            full={comment.timeFull}
            label={comment.timeLabel}
          />
        </CommentAuthor>
        <CommentMarkdown body={comment.body} />
        <CommentRunLink
          commentId={comment.id}
          instrumentId={comment.run.instrumentId}
          instrumentName={comment.run.instrumentDisplayName}
          runId={comment.run.runId}
        />
      </article>
    </li>
  );
}

export function CommentFeedList({
  emptyLabel,
  sections,
}: {
  emptyLabel: string;
  sections: CommentDaySection<CommentFeedEntry>[];
}) {
  if (sections.length === 0) {
    return (
      <p className="rounded-xl bg-card px-4 py-8 text-center text-muted-foreground text-sm ring-1 ring-foreground/10">
        {emptyLabel}
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {sections.map((section) => {
        const headingId = `comments-day-${section.dayKey}`;
        return (
          <section aria-labelledby={headingId} key={section.dayKey}>
            <h2
              className="scroll-mt-6 pt-6 font-semibold text-muted-foreground text-xs uppercase tracking-wider"
              id={headingId}
            >
              {section.label}
            </h2>
            <ul>
              {section.items.map((comment) => (
                <CommentFeedRow comment={comment} key={comment.id} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function CommentFeedSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading comments"
      className="flex flex-col gap-3 pt-6"
      role="status"
    >
      <Skeleton className="h-4 w-24" />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton className="h-24 w-full" key={index} />
      ))}
    </div>
  );
}
