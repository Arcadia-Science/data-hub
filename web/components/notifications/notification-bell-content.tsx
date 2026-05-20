"use client";

import {
  useNotifications,
  type NotificationItem,
} from "@/components/notifications/notifications-provider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { avatarColor } from "@/lib/avatar-color";
import { cn, formatRelativeTime } from "@/lib/utils";
import { BellOff } from "lucide-react";
import Link from "next/link";

// Mapping a notification row to a human-readable summary line. Kept here
// (rather than at the API boundary) so the trigger taxonomy in the DB
// stays separate from the presentational copy.
function renderSummary(n: NotificationItem): string {
  switch (n.type) {
    case "run_created":
      return `New run on ${n.instrumentDisplayName}`;
    case "comment_attributed":
      return n.actor
        ? `${n.actor.displayName} commented on a run you ran`
        : "New comment on a run you ran";
    case "comment_participated":
      return n.actor
        ? `${n.actor.displayName} replied on a run you commented on`
        : "New reply on a run you commented on";
  }
}

function notificationHref(n: NotificationItem): string {
  // Anchor to the comment id when present so the destination page can
  // scroll the comment into view.
  const base = `/instruments/${encodeURIComponent(
    n.instrumentId
  )}/runs/${encodeURIComponent(n.runDisplayId)}`;
  return n.commentId ? `${base}#comment-${n.commentId}` : base;
}

export function NotificationBellContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { recent, markAllRead, markOneRead, unreadCount } = useNotifications();

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b pb-2">
        <p className="text-sm font-medium">Notifications</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void markAllRead();
          }}
          disabled={unreadCount === 0}
        >
          Mark all as read
        </Button>
      </div>

      {recent.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <BellOff className="size-6 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">
            You&apos;re all caught up.
          </p>
          <p className="text-xs text-muted-foreground/70">
            New runs and replies will show up here when you have something
            subscribed.
          </p>
        </div>
      ) : (
        <ul className="-mx-1 max-h-[60vh] overflow-y-auto py-1">
          {recent.map((n) => {
            const isUnread = n.readAt === null;
            return (
              <li key={n.id}>
                <Link
                  href={notificationHref(n)}
                  onClick={() => {
                    // Mark this row read as the user navigates into it —
                    // gated on `isUnread` so re-clicking a read row
                    // doesn't fire a pointless POST. The provider
                    // handles its own optimistic update + error toast.
                    if (isUnread) void markOneRead(n.id);
                    onNavigate?.();
                  }}
                  className={cn(
                    "flex items-start gap-3 rounded-md px-3 py-2 hover:bg-muted",
                    isUnread && "bg-primary/5"
                  )}
                >
                  {n.actor ? (
                    <Avatar size="sm">
                      {n.actor.avatarUrl ? (
                        <AvatarImage
                          src={n.actor.avatarUrl}
                          alt={n.actor.displayName}
                        />
                      ) : null}
                      <AvatarFallback className={avatarColor(n.actor.id)}>
                        {n.actor.initials}
                      </AvatarFallback>
                    </Avatar>
                  ) : (
                    <span
                      aria-hidden
                      className="mt-1.5 inline-block size-2 shrink-0 rounded-full bg-primary"
                    />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm leading-snug">
                      {renderSummary(n)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{n.runDisplayId}</span>
                      {" · "}
                      <span suppressHydrationWarning>
                        {formatRelativeTime(n.createdAt)}
                      </span>
                    </span>
                  </span>
                  {isUnread ? (
                    <span
                      aria-label="Unread"
                      className="mt-1.5 inline-block size-2 shrink-0 rounded-full bg-primary"
                    />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
