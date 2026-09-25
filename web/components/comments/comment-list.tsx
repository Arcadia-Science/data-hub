import { ArrowRight, SearchX } from "lucide-react";
import Link from "next/link";
import { CommentRow } from "@/components/comments/comment-row";
import { Skeleton } from "@/components/ui/skeleton";
import { TabsContent } from "@/components/ui/tabs";
import type { CommentFeedItem } from "@/lib/api/run-comments";
import { type CommentRowModel, toCommentRow } from "@/lib/comments/present";

export function CommentList({ comments }: { comments: CommentRowModel[] }) {
  return (
    <ul className="overflow-hidden rounded-lg border bg-background dark:bg-muted">
      {comments.map((comment) => (
        <li
          className="border-border border-t first:border-t-0"
          key={comment.id}
        >
          <CommentRow comment={comment} />
        </li>
      ))}
    </ul>
  );
}

export function CommentEmpty({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
      <SearchX className="size-8 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">{label}</p>
    </div>
  );
}

export function CommentRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background dark:bg-muted">
      {Array.from({ length: rows }, (_, index) => (
        <div
          className="flex gap-3.5 border-border border-t px-5 py-[18px] first:border-t-0"
          key={index}
        >
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-7 w-56 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

const PREVIEW_GRID_CLASS = "grid grid-cols-1 gap-3 lg:grid-cols-2";

function CommentPreviewGrid({ comments }: { comments: CommentRowModel[] }) {
  return (
    <ul className={PREVIEW_GRID_CLASS}>
      {comments.map((comment) => (
        <li
          className="overflow-hidden rounded-lg border bg-background dark:bg-muted"
          key={comment.id}
        >
          <CommentRow comment={comment} />
        </li>
      ))}
    </ul>
  );
}

export function CommentListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading comments"
      className={PREVIEW_GRID_CLASS}
      role="status"
    >
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton className="h-32 rounded-lg" key={index} />
      ))}
    </div>
  );
}

function ViewAllCommentsLink({ href }: { href: string }) {
  return (
    <Link
      className="flex items-center justify-center gap-1.5 rounded-md px-4 py-2.5 text-muted-foreground text-sm transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={href}
    >
      View all comments
      <ArrowRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

export function CommentPreview({
  comments,
  emptyLabel,
  href,
  timeZone,
}: {
  comments: CommentFeedItem[];
  emptyLabel: string;
  href: string;
  timeZone: string;
}) {
  const rows = comments.map((comment) => toCommentRow(comment, timeZone));
  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <CommentEmpty label={emptyLabel} />
      ) : (
        <CommentPreviewGrid comments={rows} />
      )}
      {rows.length > 0 ? <ViewAllCommentsLink href={href} /> : null}
    </div>
  );
}

export function CommentPreviewPanel({
  comments,
  emptyLabel,
  href,
  timeZone,
  value,
}: {
  comments: CommentFeedItem[];
  emptyLabel: string;
  href: string;
  timeZone: string;
  value: string;
}) {
  return (
    <TabsContent value={value}>
      <CommentPreview
        comments={comments}
        emptyLabel={emptyLabel}
        href={href}
        timeZone={timeZone}
      />
    </TabsContent>
  );
}
