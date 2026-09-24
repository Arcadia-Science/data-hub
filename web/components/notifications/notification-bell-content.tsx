"use client";

import { BellOff, Settings } from "lucide-react";
import Link from "next/link";
import { type MouseEvent, type ReactNode, useMemo } from "react";
import { useNotifications } from "@/components/notifications/notifications-provider";
import { RunGroup } from "@/components/notifications/run-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UnknownUserAvatar, UserAvatar } from "@/components/user-avatar";
import { runCommentHref } from "@/lib/comment-hash";
import { applySamePageCommentHash } from "@/lib/comment-hash-nav";
import { getBrowserTimeZone } from "@/lib/date";
import {
  buildNotificationFeed,
  isAnchored,
} from "@/lib/notifications/group-feed";
import type { NotificationItem } from "@/lib/notifications/types";
import { cn, formatRelativeTime } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Bell popover content. The provider is the single source of truth for
// raw notification rows; this module owns presentation — date bucketing,
// and the comment / generic row layouts. Grouped `run_created` rows live
// in `run-group.tsx` as a compound component.
// ---------------------------------------------------------------------------

function notificationHref(n: {
  instrumentId: string;
  runDisplayId: string;
  commentId: string | null;
}): string {
  return runCommentHref(n.instrumentId, n.runDisplayId, n.commentId);
}

function handleNotificationNavigate(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onActivate: () => void
) {
  onActivate();
  if (applySamePageCommentHash(href)) {
    event.preventDefault();
  }
}

function commentActionLabel(n: NotificationItem): string {
  const actor = n.actor?.displayName ?? "Someone";
  switch (n.type) {
    case "comment_attributed":
      return `${actor} commented on a run you ran on`;
    case "comment_participated":
      return `${actor} commented on a run you've commented on`;
    case "run_created":
      return `${actor} created`;
    case "generic":
      return `${actor} sent a notification`;
    default:
      return `${actor} commented on`;
  }
}

const EMPTY_STATE = (
  <div className="flex flex-col items-center justify-center gap-2 px-3 py-12 text-center">
    <BellOff className="size-6 text-muted-foreground/60" />
    <p className="text-muted-foreground text-sm">You&apos;re all caught up.</p>
    <p className="text-muted-foreground/70 text-xs">
      New runs and replies will show up here when you have something subscribed.
    </p>
  </div>
);

export function NotificationBellContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { recent, markAllRead, markOneRead, unreadCount } = useNotifications();
  const timeZone = getBrowserTimeZone();

  const sections = useMemo(
    () => buildNotificationFeed(recent, timeZone, new Date()),
    [recent, timeZone]
  );

  const isEmpty = recent.length === 0;
  const hasUnread = unreadCount > 0;

  return (
    <div className="flex flex-col">
      <NotificationsHeader
        hasUnread={hasUnread}
        onMarkAllRead={() => {
          void markAllRead();
        }}
        onNavigate={onNavigate}
        unreadCount={unreadCount}
      />
      {isEmpty ? (
        EMPTY_STATE
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          {sections.map((section) => (
            <NotificationSection key={section.dayKey} label={section.label}>
              {section.entries.map((entry) => {
                if (entry.kind === "run_group") {
                  return (
                    <RunGroup.Provider
                      group={entry}
                      key={entry.id}
                      onActivate={(notificationId) => {
                        void markOneRead(notificationId);
                      }}
                      onNavigate={onNavigate}
                    >
                      <RunGroup.Frame>
                        <RunGroup.Header />
                        <RunGroup.Body>
                          <RunGroup.Runs />
                          <RunGroup.ShowMore />
                        </RunGroup.Body>
                      </RunGroup.Frame>
                    </RunGroup.Provider>
                  );
                }
                const activate = () => {
                  if (entry.notification.readAt === null) {
                    void markOneRead(entry.notification.id);
                  }
                  onNavigate?.();
                };
                if (entry.kind === "feedback") {
                  return (
                    <AnchorlessNotificationRow
                      heading={feedbackHeading(entry.notification)}
                      href={
                        entry.notification.type === "feedback_submitted" &&
                        entry.notification.feedbackId
                          ? `/settings/feedback?item=${entry.notification.feedbackId}`
                          : undefined
                      }
                      key={entry.id}
                      notification={entry.notification}
                      onActivate={activate}
                    />
                  );
                }
                return entry.kind === "comment" ? (
                  <CommentNotificationRow
                    key={entry.id}
                    notification={entry.notification}
                    onActivate={activate}
                  />
                ) : (
                  <AnchorlessNotificationRow
                    heading={entry.notification.body}
                    key={entry.id}
                    notification={entry.notification}
                    onActivate={activate}
                  />
                );
              })}
            </NotificationSection>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationsHeader({
  unreadCount,
  hasUnread,
  onMarkAllRead,
  onNavigate,
}: {
  unreadCount: number;
  hasUnread: boolean;
  onMarkAllRead: () => void;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-sm tracking-tight">Notifications</h2>
        {hasUnread ? (
          <Badge
            aria-label={`${unreadCount} unread`}
            className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
          >
            {unreadCount > 99 ? "99+" : unreadCount} new
          </Badge>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <Button
          aria-label="Notification settings"
          asChild
          size="icon-sm"
          variant="ghost"
        >
          <Link href="/settings/notifications" onClick={() => onNavigate?.()}>
            <Settings />
          </Link>
        </Button>
        <Button
          disabled={!hasUnread}
          onClick={onMarkAllRead}
          size="sm"
          type="button"
          variant="outline"
        >
          Mark all read
        </Button>
      </div>
    </div>
  );
}

function NotificationSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="border-b bg-muted px-4 py-1.5 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      <ul>{children}</ul>
    </section>
  );
}

function NotificationRowShell({
  isUnread,
  children,
}: {
  isUnread: boolean;
  children: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "group/notification relative border-border border-b border-l-2 transition-colors last:border-b-0",
        isUnread
          ? "border-l-primary bg-primary/5 hover:bg-primary/10"
          : "border-l-transparent hover:bg-muted/60"
      )}
    >
      {children}
    </li>
  );
}

function CommentNotificationRow({
  notification: n,
  onActivate,
}: {
  notification: NotificationItem & {
    runId: string;
    runDisplayId: string;
    instrumentId: string;
  };
  onActivate: () => void;
}) {
  const isUnread = n.readAt === null;
  const href = notificationHref(n);

  return (
    <NotificationRowShell isUnread={isUnread}>
      <Link
        className="flex items-start gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        href={href}
        onClick={(event) => handleNotificationNavigate(event, href, onActivate)}
        scroll={!n.commentId}
      >
        {n.actor ? (
          <UserAvatar
            size="sm"
            user={{
              userId: n.actor.id,
              displayName: n.actor.displayName,
              initials: n.actor.initials,
              avatarUrl: n.actor.avatarUrl,
            }}
          />
        ) : (
          <UnknownUserAvatar size="sm" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm leading-snug">
            <span className="font-medium">{commentActionLabel(n)}</span>{" "}
            <span className="font-medium text-primary">{n.runDisplayId}</span>
          </p>
          {n.commentBody ? (
            <p className="line-clamp-2 text-muted-foreground text-sm italic">
              &ldquo;{n.commentBody}&rdquo;
            </p>
          ) : null}
          <p
            className="text-muted-foreground/80 text-xs"
            suppressHydrationWarning
          >
            {formatRelativeTime(n.createdAt)}
          </p>
        </div>
      </Link>
    </NotificationRowShell>
  );
}

function feedbackHeading(n: NotificationItem): ReactNode {
  if (n.type === "feedback_submitted") {
    return (
      <>
        <span className="font-medium">{n.actor?.displayName ?? "Someone"}</span>{" "}
        sent feedback
      </>
    );
  }
  return <span className="font-medium">Update on your feedback</span>;
}

function AnchorlessNotificationRow({
  heading,
  href,
  notification: n,
  onActivate,
}: {
  heading: ReactNode;
  href?: string;
  notification: NotificationItem;
  onActivate: () => void;
}) {
  const isUnread = n.readAt === null;
  const anchored = href === undefined && isAnchored(n);
  const linkHref = href ?? (anchored ? notificationHref(n) : undefined);
  const content = (
    <>
      {n.actor ? (
        <UserAvatar
          size="sm"
          user={{
            userId: n.actor.id,
            displayName: n.actor.displayName,
            initials: n.actor.initials,
            avatarUrl: n.actor.avatarUrl,
          }}
        />
      ) : (
        <UnknownUserAvatar size="sm" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm leading-snug">{heading}</p>
        {n.type === "feedback_submitted" || n.type === "feedback_updated" ? (
          n.body ? (
            <p
              className={
                n.type === "feedback_updated"
                  ? "line-clamp-3 text-muted-foreground text-sm"
                  : "truncate text-muted-foreground text-sm"
              }
            >
              {n.body}
            </p>
          ) : null
        ) : anchored ? (
          <p className="line-clamp-2 font-mono text-muted-foreground text-xs">
            {n.instrumentDisplayName} · {n.runDisplayId}
          </p>
        ) : null}
        <p
          className="text-muted-foreground/80 text-xs"
          suppressHydrationWarning
        >
          {formatRelativeTime(n.createdAt)}
        </p>
      </div>
    </>
  );

  if (linkHref) {
    return (
      <NotificationRowShell isUnread={isUnread}>
        <Link
          className="flex items-start gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          href={linkHref}
          onClick={
            href
              ? onActivate
              : (event) =>
                  handleNotificationNavigate(event, linkHref, onActivate)
          }
          scroll={!n.commentId}
        >
          {content}
        </Link>
      </NotificationRowShell>
    );
  }

  return (
    <NotificationRowShell isUnread={isUnread}>
      <button
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onActivate}
        type="button"
      >
        {content}
      </button>
    </NotificationRowShell>
  );
}
