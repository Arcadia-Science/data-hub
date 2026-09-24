import Link from "next/link";
import type { ReactNode } from "react";
import { UserAvatarLink } from "@/components/user-avatar";
import type { UserAvatarUser } from "@/lib/avatar-color";
import { runCommentHref } from "@/lib/comment-hash";
import { cn } from "@/lib/utils";

export function CommentAuthor({
  user,
  children,
}: {
  user: UserAvatarUser;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-x-2 text-muted-foreground text-sm">
      <UserAvatarLink className="relative z-10 min-w-0" size="sm" user={user}>
        <span className="truncate font-medium text-foreground">
          {user.displayName}
        </span>
      </UserAvatarLink>
      <span aria-hidden="true">·</span>
      {children}
    </div>
  );
}

export function CommentRunLabel({
  instrumentName,
  runId,
}: {
  instrumentName: string;
  runId: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
      <span className="min-w-0 truncate">{instrumentName}</span>
      <span
        className="max-w-56 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        translate="no"
      >
        {runId}
      </span>
    </span>
  );
}

export function CommentOverlayLink({
  instrumentId,
  instrumentName,
  runId,
  commentId,
  className,
}: {
  instrumentId: string;
  instrumentName: string;
  runId: string;
  commentId: string;
  className?: string;
}) {
  return (
    <Link
      className={cn(
        "inline-flex min-w-0 max-w-full rounded-sm outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring",
        className
      )}
      href={runCommentHref(instrumentId, runId, commentId)}
    >
      <span className="sr-only">Open comment on </span>
      <CommentRunLabel instrumentName={instrumentName} runId={runId} />
    </Link>
  );
}
