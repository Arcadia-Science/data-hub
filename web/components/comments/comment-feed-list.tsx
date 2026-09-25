import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { CommentDaySection } from "@/lib/comments/group-by-day";
import {
  type CommentRowModel,
  commentCountLabel,
} from "@/lib/comments/present";
import { cn } from "@/lib/utils";
import { CommentEmpty, CommentList, CommentRowsSkeleton } from "./comment-list";

const commentPagerClassName = cn(
  buttonVariants({ variant: "outline" }),
  "h-11 px-[18px]"
);

function CommentPager({
  newerHref,
  olderHref,
}: {
  newerHref: string | null;
  olderHref: string | null;
}) {
  if (newerHref === null && olderHref === null) {
    return null;
  }
  return (
    <div className="flex flex-wrap justify-center gap-3">
      {newerHref === null ? null : (
        <Link className={commentPagerClassName} href={newerHref}>
          Show newer comments
        </Link>
      )}
      {olderHref === null ? null : (
        <Link className={commentPagerClassName} href={olderHref}>
          Show older comments
        </Link>
      )}
    </div>
  );
}

export function CommentFeedList({
  emptyLabel,
  newerHref,
  olderHref,
  sections,
}: {
  emptyLabel: string;
  newerHref: string | null;
  olderHref: string | null;
  sections: CommentDaySection<CommentRowModel>[];
}) {
  if (sections.length === 0) {
    return (
      <div className="flex flex-col gap-8">
        <CommentEmpty label={emptyLabel} />
        <CommentPager newerHref={newerHref} olderHref={olderHref} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {sections.map((section) => {
        const headingId = `comments-day-${section.dayKey}`;
        return (
          <section
            aria-labelledby={headingId}
            className="flex flex-col gap-3"
            key={section.dayKey}
          >
            <div className="flex items-baseline justify-between gap-4 px-1">
              <h2
                className="scroll-mt-6 font-semibold text-[15px] leading-5"
                id={headingId}
              >
                {section.label}
              </h2>
              <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
                {commentCountLabel(section.items.length)}
              </span>
            </div>
            <CommentList comments={section.items} />
          </section>
        );
      })}
      <CommentPager newerHref={newerHref} olderHref={olderHref} />
    </div>
  );
}

export function CommentFeedSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading comments"
      className="flex flex-col gap-8"
      role="status"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between px-1">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-16" />
        </div>
        <CommentRowsSkeleton rows={4} />
      </div>
    </div>
  );
}
