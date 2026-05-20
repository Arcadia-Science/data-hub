"use client";

import { NotificationBellContent } from "@/components/notifications/notification-bell-content";
import { useNotifications } from "@/components/notifications/notifications-provider";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Bell } from "lucide-react";
import { useState } from "react";

// Bell + Popover wrapper. Kept separate from the popover content so the
// content component can subscribe to `recent` without re-rendering the
// trigger button on every poll.
export function NotificationBell() {
  const { unreadCount, refresh } = useNotifications();
  const [open, setOpen] = useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Pull fresh data when the popover opens so the user sees the
        // latest list even between polling ticks. Failures are silent —
        // the polling loop will retry.
        if (next) void refresh();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : "Notifications"
          }
          className="relative"
        >
          <Bell />
          {/* Badge renders only when count > 0 (per
              `rendering-conditional-render`); the trailing two-digit cap
              keeps the badge from breaking the icon-button bounds. */}
          {unreadCount > 0 ? (
            <span
              aria-hidden
              className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground tabular-nums"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-96 p-4">
        <NotificationBellContent onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
