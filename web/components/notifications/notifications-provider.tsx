"use client";

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import type { ActorToken } from "@/lib/api/actor";
import type { NotificationItem } from "@/lib/notifications/types";

export type { NotificationItem } from "@/lib/notifications/types";

// ---------------------------------------------------------------------------
// Notifications provider — single source of truth for the bell badge and
// popover content. Decouples the rest of the UI from the API shape.
//
// The value is split in two contexts so the bell button, which sits in every
// page header, re-renders when the unread count changes but not each time the
// list of recent notifications does. `useNotifications` joins both for the
// popover content, and `useNotificationsSummary` reads only the badge half.
// ---------------------------------------------------------------------------

interface NotificationsSummary {
  markAllRead: () => Promise<void>;
  markOneRead: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  unreadCount: number;
}

interface NotificationsList {
  recent: NotificationItem[];
}

type NotificationsValue = NotificationsSummary & NotificationsList;

const NotificationsSummaryContext = createContext<NotificationsSummary | null>(
  null
);
const NotificationsListContext = createContext<NotificationsList | null>(null);

// Re-poll cadence for the bell badge + popover list while the tab is
// visible. Hidden tabs don't poll at all — the visibilitychange listener
// in the effect below kicks an immediate refresh when the tab comes
// back, so freshness on focus is preserved without burning RTTs on
// background tabs.
const POLL_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Wire shape returned by `GET /api/v1/notifications`. Maps snake_case
// → camelCase at the boundary so the rest of the client tree never
// sees the API's casing.
// ---------------------------------------------------------------------------

interface ApiNotification {
  // Set when a person caused the row; at most one of `actor` and
  // `actor_token` is set.
  actor: {
    avatarUrl: string | null;
    displayName: string;
    id: string;
    initials: string;
  } | null;
  actor_token: ActorToken | null;
  body: string | null;
  comment_body: string | null;
  comment_id: string | null;
  created_at: string;
  feedback_id: string | null;
  file_count: number | null;
  files_failed: number | null;
  id: string;
  instrument_display_name: string | null;
  instrument_id: string | null;
  instrument_type: NotificationItem["instrumentType"];
  read_at: string | null;
  run_acquired_at: string | null;
  run_display_id: string | null;
  run_id: string | null;
  type: NotificationItem["type"];
}

function actorFromApi(n: ApiNotification): NotificationItem["actor"] {
  if (n.actor) {
    return {
      kind: "user",
      user: {
        userId: n.actor.id,
        displayName: n.actor.displayName,
        initials: n.actor.initials,
        avatarUrl: n.actor.avatarUrl,
      },
    };
  }
  return n.actor_token ? { kind: "token", token: n.actor_token } : null;
}

function fromApi(n: ApiNotification): NotificationItem {
  return {
    id: n.id,
    type: n.type,
    createdAt: n.created_at,
    readAt: n.read_at,
    runId: n.run_id,
    runDisplayId: n.run_display_id,
    runAcquiredAt: n.run_acquired_at,
    fileCount: n.file_count,
    filesFailed: n.files_failed,
    instrumentId: n.instrument_id,
    instrumentDisplayName: n.instrument_display_name,
    instrumentType: n.instrument_type,
    commentId: n.comment_id,
    commentBody: n.comment_body,
    body: n.body,
    feedbackId: n.feedback_id,
    actor: actorFromApi(n),
  };
}

export function NotificationsProvider({
  initialUnreadCount,
  children,
}: {
  initialUnreadCount: number;
  children: ReactNode;
}) {
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [recent, setRecent] = useState<NotificationItem[]>([]);
  // The last list that came from the server, as text. A poll that returns the
  // same list leaves `recent` alone, so nothing downstream re-renders. Local
  // edits clear it, so the next poll always replaces what the user sees.
  const lastServerList = useRef("");

  // Functional setState in the fetcher means `refresh` doesn't depend on
  // the latest `unreadCount` / `recent` — its identity stays stable across
  // renders, which keeps the polling effect from tearing down its
  // setInterval on every state update.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/notifications", { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const body = (await res.json()) as {
        unreadCount: number;
        notifications: ApiNotification[];
      };
      setUnreadCount(body.unreadCount);
      const serialized = JSON.stringify(body.notifications);
      if (serialized !== lastServerList.current) {
        lastServerList.current = serialized;
        setRecent(body.notifications.map(fromApi));
      }
    } catch {
      // Network blips during polling are silently ignored — the next tick
      // will retry. Failures on user-initiated refresh (popover open) are
      // visible via the empty-state copy when nothing has loaded yet.
    }
  }, []);

  const markAllRead = useCallback(async () => {
    // Optimistically clear the badge + flag every recent row read.
    // Failure recovers truth via a follow-up refresh.
    const stampedAt = new Date().toISOString();
    lastServerList.current = "";
    setUnreadCount(() => 0);
    setRecent((prev) =>
      prev.map((n) => (n.readAt ? n : { ...n, readAt: stampedAt }))
    );
    try {
      const res = await fetch("/api/v1/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      toast.error("Couldn't mark notifications as read", {
        description:
          err instanceof Error ? err.message : "An unexpected error occurred.",
      });
      await refresh();
    }
  }, [refresh]);

  // Mark a single notification read — used when the popover row is
  // clicked through to its target. Callers are expected to gate this on
  // `readAt === null` (the optimistic update + server filter make a
  // redundant call harmless, but skipping it avoids a pointless RTT).
  const markOneRead = useCallback(
    async (id: string) => {
      const stampedAt = new Date().toISOString();
      lastServerList.current = "";
      setRecent((prev) =>
        prev.map((n) =>
          n.id === id && !n.readAt ? { ...n, readAt: stampedAt } : n
        )
      );
      // Clamp at zero so any drift between the cached `recent` list and
      // the server-side unread count can't push the badge negative.
      setUnreadCount((count) => Math.max(0, count - 1));
      try {
        const res = await fetch("/api/v1/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [id] }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        toast.error("Couldn't mark notification as read", {
          description:
            err instanceof Error
              ? err.message
              : "An unexpected error occurred.",
        });
        await refresh();
      }
    },
    [refresh]
  );

  // Initial fetch on mount, then poll every minute *only* while the tab
  // is visible. `visibilitychange` resumes the loop (and does an
  // immediate refresh) when the user comes back to the tab so the badge
  // catches up without waiting for the next tick. `refresh` identity is
  // stable so the effect runs once.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId != null) {
        return;
      }
      intervalId = setInterval(refresh, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (intervalId == null) {
        return;
      }
      clearInterval(intervalId);
      intervalId = null;
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        start();
      } else {
        stop();
      }
    };

    void refresh();
    if (document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stop();
    };
  }, [refresh]);

  const summary = useMemo(
    () => ({ unreadCount, refresh, markAllRead, markOneRead }),
    [unreadCount, refresh, markAllRead, markOneRead]
  );
  const list = useMemo(() => ({ recent }), [recent]);

  return (
    <NotificationsSummaryContext value={summary}>
      <NotificationsListContext value={list}>
        {children}
      </NotificationsListContext>
    </NotificationsSummaryContext>
  );
}

const MISSING_PROVIDER =
  "useNotifications must be used within a <NotificationsProvider>";

/** The unread count and the actions, for the bell button. */
export function useNotificationsSummary(): NotificationsSummary {
  const summary = use(NotificationsSummaryContext);
  if (!summary) {
    throw new Error(MISSING_PROVIDER);
  }
  return summary;
}

/** Everything, including the recent list, for the popover content. */
export function useNotifications(): NotificationsValue {
  const summary = useNotificationsSummary();
  const list = use(NotificationsListContext);
  if (!list) {
    throw new Error(MISSING_PROVIDER);
  }
  return useMemo(() => ({ ...summary, ...list }), [summary, list]);
}
