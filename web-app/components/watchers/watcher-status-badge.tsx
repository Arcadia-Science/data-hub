"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WatcherOnlineStatus } from "@/components/watchers/watcher-online-status";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Radio, WifiOff } from "lucide-react";

const STATUS_CONFIG: Record<
  WatcherOnlineStatus,
  {
    label: string;
    Icon: typeof Radio;
    className: string;
  }
> = {
  online: {
    label: "Online",
    Icon: Radio,
    className:
      "border-transparent bg-green-500/10 text-green-700 dark:bg-green-500/15 dark:text-green-400",
  },
  offline: {
    label: "Offline",
    Icon: WifiOff,
    className:
      "border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20",
  },
  no_watcher: {
    label: "No Watcher",
    Icon: WifiOff,
    className: "border-border text-muted-foreground",
  },
};

export function WatcherStatusBadge({
  status,
  lastOnlineAt,
  verbose = false,
  className,
}: {
  status: WatcherOnlineStatus;
  /**
   * Most recent watcher heartbeat for the instrument. When the badge is in
   * `offline` state and this is provided, it's surfaced via tooltip so users
   * can tell at a glance how long the instrument has been silent.
   */
  lastOnlineAt?: Date | null;
  /**
   * When true, prefixes the label with "Watcher" (e.g. "Watcher Online").
   * Useful in headers where the badge stands alone outside a status column.
   * The `no_watcher` label ("No Watcher") is never prefixed.
   */
  verbose?: boolean;
  className?: string;
}) {
  const { label, Icon, className: variantClassName } = STATUS_CONFIG[status];
  const fullLabel =
    verbose && status !== "no_watcher" ? `Watcher ${label}` : label;

  const badge = (
    <Badge className={cn(variantClassName, className)}>
      <Icon />
      {fullLabel}
    </Badge>
  );

  if (status !== "offline" || !lastOnlineAt) {
    return badge;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="flex flex-col gap-1">
        <div>Last online {formatRelativeTime(lastOnlineAt)}</div>
      </TooltipContent>
    </Tooltip>
  );
}
