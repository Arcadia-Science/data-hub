import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { CommentCard } from "@/components/comments/comment-card";
import { Skeleton } from "@/components/ui/skeleton";
import type { CommentFeedItem } from "@/lib/api/run-comments";

export function CommentCardGrid({
  comments,
  emptyLabel,
}: {
  comments: CommentFeedItem[];
  emptyLabel: string;
}) {
  if (comments.length === 0) {
    return (
      <p className="rounded-xl bg-card px-4 py-8 text-center text-muted-foreground text-sm ring-1 ring-foreground/10">
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {comments.map((comment) => (
        <li key={comment.id}>
          <CommentCard comment={comment} />
        </li>
      ))}
    </ul>
  );
}

export function ViewAllCommentsLink({ href }: { href: string }) {
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

export function CommentCardGridSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading comments"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      role="status"
    >
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton className="h-36 rounded-xl" key={index} />
      ))}
    </div>
  );
}
