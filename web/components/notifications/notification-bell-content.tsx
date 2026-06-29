"use client";

import {
  Activity,
  BellOff,
  ChevronDown,
  FlaskConical,
  Image as ImageIcon,
  type LucideIcon,
  Microscope,
  Radar,
  ScanLine,
  Settings,
  TestTube,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  type NotificationItem,
  useNotifications,
} from "@/components/notifications/notifications-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UnknownUserAvatar, UserAvatar } from "@/components/user-avatar";
import type { InstrumentType } from "@/lib/db/schema";
import { cn, formatRelativeTime } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Bell popover content. The provider is the single source of truth for
// raw notification rows; this module owns presentation — date bucketing,
// per-instrument grouping of `run_created` rows, and the variant-specific
// row layouts. Splitting the variants into their own components keeps the
// top-level render flat and avoids the `isCommentRow` / `isGroupedRow`
// boolean flag explosion an "all-in-one" row would invite.
// ---------------------------------------------------------------------------

// Lookup map for the per-instrument-type icon used on grouped `run_created`
// rows. Defined at module scope so we don't rebuild the map on every render
// (per `js-index-maps`). `generic` is the safe fallback for any future
// instrument-type the enum gains before this map catches up.
const INSTRUMENT_TYPE_ICON: Record<InstrumentType, LucideIcon> = {
  generic: FlaskConical,
  plate_reader: Activity,
  gel_doc: ImageIcon,
  qpcr: TestTube,
  tape_station: Microscope,
  hina_microscope: Microscope,
  epson_v700_scanner: ScanLine,
  instant_raman: Radar,
};

// Bucket labels live alongside the buckets themselves so the section
// renderer can iterate `BUCKET_ORDER` and stay in lockstep with the
// grouping logic below.
const BUCKET_ORDER = ["today", "yesterday", "earlier"] as const;
type Bucket = (typeof BUCKET_ORDER)[number];
const BUCKET_LABEL: Record<Bucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

interface CommentEntry {
  id: string;
  kind: "comment";
  notification: NotificationItem;
}

interface RunGroupEntry {
  id: string;
  instrumentDisplayName: string;
  instrumentId: string;
  instrumentType: InstrumentType;
  kind: "run_group";
  latestCreatedAt: string;
  runs: NotificationItem[];
}

type Entry = CommentEntry | RunGroupEntry;
type BucketedEntries = Record<Bucket, Entry[]>;

function notificationHref(n: NotificationItem): string {
  // Anchor to the comment id when present so the destination page can
  // scroll the comment into view.
  const base = `/instruments/${encodeURIComponent(
    n.instrumentId
  )}/runs/${encodeURIComponent(n.runDisplayId)}`;
  return n.commentId ? `${base}#comment-${n.commentId}` : base;
}

function commentActionLabel(n: NotificationItem): string {
  // The actor is nullable at the type level (deleted user, etc.); fall
  // back to a generic phrasing so the row still reads cleanly. Wording
  // mirrors the notification preference labels in settings.
  const actor = n.actor?.displayName ?? "Someone";
  switch (n.type) {
    case "comment_attributed":
      return `${actor} commented on a run you ran on`;
    case "comment_participated":
      return `${actor} commented on a run you've commented on`;
    case "run_created":
      // Unreachable — `run_created` never flows into the comment row
      // renderer — but exhaustive switches keep TS honest.
      return `${actor} created`;
    default:
      return `${actor} commented on`;
  }
}

function bucketOf(createdAt: string, now: Date): Bucket {
  const created = new Date(createdAt);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  if (created >= startOfToday) {
    return "today";
  }
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (created >= startOfYesterday) {
    return "yesterday";
  }
  return "earlier";
}

// Builds the bucketed + grouped entry list from the raw notification feed.
// Pure function — extracted so the main component's `useMemo` body stays
// declarative and the grouping logic is unit-testable in isolation.
function buildEntries(items: NotificationItem[], now: Date): BucketedEntries {
  const buckets: BucketedEntries = { today: [], yesterday: [], earlier: [] };
  // Track the active run-group per (bucket, instrumentId) so out-of-order
  // run_created rows within the same instrument still collapse into one
  // row. Items themselves arrive sorted desc by createdAt so the first
  // hit is the newest.
  const groupIndex = new Map<string, RunGroupEntry>();

  for (const n of items) {
    const bucket = bucketOf(n.createdAt, now);
    if (n.type === "run_created") {
      const key = `${bucket}:${n.instrumentId}`;
      const existing = groupIndex.get(key);
      if (existing) {
        existing.runs.push(n);
        // The list is desc-sorted, so `latestCreatedAt` is set on the
        // first hit and never needs to advance — leave it alone.
      } else {
        const group: RunGroupEntry = {
          kind: "run_group",
          id: `group:${key}`,
          instrumentId: n.instrumentId,
          instrumentType: n.instrumentType,
          instrumentDisplayName: n.instrumentDisplayName,
          runs: [n],
          latestCreatedAt: n.createdAt,
        };
        groupIndex.set(key, group);
        buckets[bucket].push(group);
      }
    } else {
      buckets[bucket].push({ kind: "comment", id: n.id, notification: n });
    }
  }

  return buckets;
}

// Hoisted outside the component so the empty-state JSX subtree is created
// once at module load instead of on every render (per `rendering-hoist-jsx`).
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

  // `now` only changes when `recent` does — the bucket boundary doesn't
  // need to drift in real time inside an open popover. Recomputing on
  // every render would otherwise re-bucket items the moment the clock
  // ticked past midnight and the popover was still open, which is
  // visually disruptive.
  const buckets = useMemo(() => buildEntries(recent, new Date()), [recent]);

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
          {BUCKET_ORDER.map((bucket) => {
            const entries = buckets[bucket];
            if (entries.length === 0) {
              return null;
            }
            return (
              <NotificationSection key={bucket} label={BUCKET_LABEL[bucket]}>
                {entries.map((entry) =>
                  entry.kind === "comment" ? (
                    <CommentNotificationRow
                      key={entry.id}
                      notification={entry.notification}
                      onActivate={() => {
                        if (entry.notification.readAt === null) {
                          void markOneRead(entry.notification.id);
                        }
                        onNavigate?.();
                      }}
                    />
                  ) : (
                    <RunGroupNotificationRow
                      group={entry}
                      key={entry.id}
                      onActivate={(notificationId) => {
                        void markOneRead(notificationId);
                      }}
                      onNavigate={onNavigate}
                    />
                  )
                )}
              </NotificationSection>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — title + unread count pill + per-user settings shortcut + mark
// all read action. Lifted out so the popover content has a single,
// predictable header surface regardless of empty/populated state.
// ---------------------------------------------------------------------------

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
            className="bg-primary/10 text-primary"
            variant="secondary"
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

// ---------------------------------------------------------------------------
// Section wrapper — sticky-ish header above its rows. Each row underneath
// is responsible for its own unread styling so the section itself stays
// agnostic to row state.
// ---------------------------------------------------------------------------

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
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Row wrapper — owns the shared unread treatment (background tint + left
// rail accent) and the focus/hover affordances. Variant components stay
// focused on their own content.
// ---------------------------------------------------------------------------

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
        "group/notification relative border-l-2 transition-colors",
        isUnread
          ? "border-l-primary bg-primary/5 hover:bg-primary/10"
          : "border-l-transparent hover:bg-muted/60"
      )}
    >
      {children}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Comment notification — actor avatar + summary line + body quote. The
// entire row is a single Link so click + keyboard activation hit the
// same target.
// ---------------------------------------------------------------------------

function CommentNotificationRow({
  notification: n,
  onActivate,
}: {
  notification: NotificationItem;
  onActivate: () => void;
}) {
  const isUnread = n.readAt === null;
  const href = notificationHref(n);

  return (
    <NotificationRowShell isUnread={isUnread}>
      <Link
        className="flex items-start gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        href={href}
        onClick={onActivate}
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

// ---------------------------------------------------------------------------
// Grouped `run_created` row — single line per (bucket, instrument).
//
// Two variants share the icon + summary layout but diverge on what's
// clickable:
//   - Single-run: the entire row is a Link to the run page (the chevron
//     is omitted; there's nothing to expand).
//   - Multi-run: the icon + summary text + chevron together form a
//     single <button> that toggles expansion. The body below (collapsed
//     comma-list or expanded per-run links) and the timestamp are
//     non-interactive so they don't compete with the toggle.
// Expansion state is local — there's nothing for the provider to know
// about it.
// ---------------------------------------------------------------------------

function RunGroupNotificationRow({
  group,
  onActivate,
  onNavigate,
}: {
  group: RunGroupEntry;
  onActivate: (notificationId: string) => void;
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = INSTRUMENT_TYPE_ICON[group.instrumentType];
  const isUnread = group.runs.some((r) => r.readAt === null);
  const count = group.runs.length;
  const isSingle = count === 1;
  // Reverse so the rendered list flows oldest→newest within the group;
  // the provider feed is desc but reading "16-02, 16-42, 17-03" matches
  // typical run-id chronology better than the inverse.
  const orderedRuns = useMemo(() => [...group.runs].reverse(), [group.runs]);

  // Shared icon block — reused between the single-run Link and the
  // multi-run toggle so the visual position stays identical between
  // variants.
  const iconBlock = (
    <span
      aria-hidden
      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/10 text-muted-foreground"
    >
      <Icon className="size-3.5" />
    </span>
  );

  if (isSingle) {
    const onlyRun = group.runs[0];
    return (
      <NotificationRowShell isUnread={isUnread}>
        <Link
          className="flex cursor-pointer items-start gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          href={notificationHref(onlyRun)}
          onClick={() => {
            if (onlyRun.readAt === null) {
              onActivate(onlyRun.id);
            }
            onNavigate?.();
          }}
        >
          {iconBlock}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-sm leading-snug">
              <span className="font-medium">1 new run</span> on{" "}
              {group.instrumentDisplayName}
            </p>
            <p className="line-clamp-2 font-mono text-muted-foreground text-xs">
              {onlyRun.runDisplayId}
            </p>
            <p
              className="text-muted-foreground/80 text-xs"
              suppressHydrationWarning
            >
              {formatRelativeTime(group.latestCreatedAt)}
            </p>
          </div>
        </Link>
      </NotificationRowShell>
    );
  }

  return (
    <NotificationRowShell isUnread={isUnread}>
      <button
        aria-expanded={expanded}
        aria-label={
          expanded
            ? `Collapse ${count} runs on ${group.instrumentDisplayName}`
            : `Expand ${count} runs on ${group.instrumentDisplayName}`
        }
        className="flex w-full cursor-pointer items-start gap-3 px-4 pt-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => setExpanded((prev) => !prev)}
        type="button"
      >
        {iconBlock}
        <span className="flex min-w-0 flex-1 items-start justify-between gap-2">
          <span className="text-sm leading-snug">
            <span className="font-medium">{count} new runs</span> on{" "}
            {group.instrumentDisplayName}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180"
            )}
          />
        </span>
      </button>

      {/* Spacer column re-uses the same `size-6 + gap-3` rhythm as the
          button above so the body content lines up under the summary
          text without resorting to a hard-coded indent value. */}
      <div className="flex items-start gap-3 px-4 pb-3">
        <span aria-hidden className="size-6 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {expanded ? (
            <ul className="flex flex-col gap-0.5">
              {orderedRuns.map((run) => (
                <li key={run.id}>
                  <Link
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 font-mono text-xs hover:bg-muted/80 focus-visible:bg-muted/80 focus-visible:outline-none",
                      run.readAt === null
                        ? "text-foreground"
                        : "text-muted-foreground"
                    )}
                    href={notificationHref(run)}
                    onClick={() => {
                      if (run.readAt === null) {
                        onActivate(run.id);
                      }
                      onNavigate?.();
                    }}
                  >
                    <span className="truncate">{run.runDisplayId}</span>
                    {run.readAt === null ? (
                      <span className="ml-auto inline-block size-1.5 shrink-0 rounded-full bg-primary" />
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="line-clamp-2 font-mono text-muted-foreground text-xs">
              {orderedRuns.map((r) => r.runDisplayId).join(", ")}
            </p>
          )}
          <p
            className="text-muted-foreground/80 text-xs"
            suppressHydrationWarning
          >
            {formatRelativeTime(group.latestCreatedAt)}
          </p>
        </div>
      </div>
    </NotificationRowShell>
  );
}
