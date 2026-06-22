"use client";

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useState,
} from "react";
import { toast } from "sonner";
import type { InstrumentType } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Notifications provider — single source of truth for the bell badge and
// popover content. Decouples the rest of the UI from the API shape: the
// only surface consumers see is `{ unreadCount, recent, markAllRead,
// refresh }`. Subcomponents that don't need `recent` (the bell badge)
// re-render only when other state slices change because the popover
// content is mounted lazily.
// ---------------------------------------------------------------------------

export type NotificationActor = {
  id: string;
  displayName: string;
  initials: string;
  avatarUrl: string | null;
};

export type NotificationItem = {
  id: string;
  type: "run_created" | "comment_attributed" | "comment_participated";
  createdAt: string;
  readAt: string | null;
  runId: string;
  runDisplayId: string;
  instrumentId: string;
  instrumentDisplayName: string;
  instrumentType: InstrumentType;
  commentId: string | null;
  commentBody: string | null;
  actor: NotificationActor | null;
};

type NotificationsValue = {
  unreadCount: number;
  recent: NotificationItem[];
  refresh: () => Promise<void>;
  markAllRead: () => Promise<void>;
  markOneRead: (id: string) => Promise<void>;
};

const NotificationsContext = createContext<NotificationsValue | null>(null);

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

type ApiNotification = {
  id: string;
  type: NotificationItem["type"];
  created_at: string;
  read_at: string | null;
  run_id: string;
  run_display_id: string;
  instrument_id: string;
  instrument_display_name: string;
  instrument_type: InstrumentType;
  comment_id: string | null;
  comment_body: string | null;
  actor: NotificationActor | null;
};

function fromApi(n: ApiNotification): NotificationItem {
  return {
    id: n.id,
    type: n.type,
    createdAt: n.created_at,
    readAt: n.read_at,
    runId: n.run_id,
    runDisplayId: n.run_display_id,
    instrumentId: n.instrument_id,
    instrumentDisplayName: n.instrument_display_name,
    instrumentType: n.instrument_type,
    commentId: n.comment_id,
    commentBody: n.comment_body,
    actor: n.actor,
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
      setRecent(body.notifications.map(fromApi));
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

  return (
    <NotificationsContext
      value={{ unreadCount, recent, refresh, markAllRead, markOneRead }}
    >
      {children}
    </NotificationsContext>
  );
}

export function useNotifications(): NotificationsValue {
  const ctx = use(NotificationsContext);
  if (!ctx) {
    throw new Error(
      "useNotifications must be used within a <NotificationsProvider>"
    );
  }
  return ctx;
}
