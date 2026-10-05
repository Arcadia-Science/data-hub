import { Activity } from "lucide-react";
import Link from "next/link";
import { CommentMarkdownPreview } from "@/components/runs/comment-markdown";
import { ActorAvatar } from "@/components/token-actor";
import { actorDisplayName } from "@/lib/api/actor";
import { runCommentHref } from "@/lib/comment-hash";
import type { CommentRowModel } from "@/lib/comments/present";

export function CommentRow({
  comment,
  timeLabel,
}: {
  comment: CommentRowModel;
  timeLabel: string;
}) {
  return (
    <Link
      className="flex h-full gap-3.5 px-5 py-[18px] text-foreground no-underline outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      href={runCommentHref(
        comment.run.instrumentId,
        comment.run.runId,
        comment.id
      )}
    >
      <ActorAvatar
        actor={comment.author}
        className="[&_[data-slot=avatar-fallback]]:font-semibold [&_[data-slot=avatar-fallback]]:text-xs"
        size="default"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex min-w-0 items-baseline justify-between gap-4">
          <span className="truncate font-semibold text-sm">
            {actorDisplayName(comment.author)}
          </span>
          <time
            className="shrink-0 text-[13px] text-muted-foreground tabular-nums"
            dateTime={comment.created_at}
            title={comment.timeFull}
          >
            {timeLabel}
          </time>
        </span>
        <CommentMarkdownPreview body={comment.body} className="text-sm" />
        <span className="mt-1.5 inline-flex h-7 max-w-full items-center gap-2 self-start rounded-md border bg-muted px-2.5 text-[13px] dark:bg-background">
          <Activity
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate text-muted-foreground">
            {comment.run.instrumentDisplayName}
          </span>
          <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />
          <span
            className="min-w-0 truncate font-mono text-[12.5px]"
            translate="no"
          >
            {comment.run.runId}
          </span>
        </span>
      </span>
    </Link>
  );
}
