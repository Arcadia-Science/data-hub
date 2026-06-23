"use client";

import { Bell } from "lucide-react";
import { useState } from "react";
import { NotificationBellContent } from "@/components/notifications/notification-bell-content";
import { useNotifications } from "@/components/notifications/notifications-provider";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// Bell + Popover wrapper. Kept separate from the popover content so the
// content component can subscribe to `recent` without re-rendering the
// trigger button on every poll.
export function NotificationBell() {
  const { unreadCount, refresh } = useNotifications();
  const [open, setOpen] = useState(false);

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        // Pull fresh data when the popover opens so the user sees the
        // latest list even between polling ticks. Failures are silent —
        // the polling loop will retry.
        if (next) {
          void refresh();
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : "Notifications"
          }
          className="relative"
          size="icon-sm"
          variant="ghost"
        >
          <Bell />
          {/* Badge renders only when count > 0 (per
              `rendering-conditional-render`); the trailing two-digit cap
              keeps the badge from breaking the icon-button bounds. */}
          {unreadCount > 0 ? (
            <span
              aria-hidden
              className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-semibold text-[10px] text-primary-foreground tabular-nums leading-none"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-104 gap-0 overflow-hidden p-0"
        sideOffset={8}
      >
        <NotificationBellContent onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
