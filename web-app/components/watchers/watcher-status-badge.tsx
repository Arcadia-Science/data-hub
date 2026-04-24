import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Radio, WifiOff } from "lucide-react";

/**
 * Rolled-up watcher status for an instrument:
 *  - `online`     — at least one watcher is actively heartbeating
 *  - `offline`    — watchers are registered but none are heartbeating
 *  - `no_watcher` — no watchers registered for the instrument
 *
 * This is distinct from the per-watcher `EffectiveStatus` in
 * `lib/api/watchers.ts`, which describes a single watcher's lifecycle.
 */
export type WatcherOnlineStatus = "online" | "offline" | "no_watcher";

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

export function getWatcherOnlineStatus({
  watcherCount,
  watchersOnline,
}: {
  watcherCount: number;
  watchersOnline: number;
}): WatcherOnlineStatus {
  if (watcherCount === 0) return "no_watcher";
  return watchersOnline > 0 ? "online" : "offline";
}

export function WatcherStatusBadge({
  status,
  verbose = false,
  className,
}: {
  status: WatcherOnlineStatus;
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

  return (
    <Badge className={cn(variantClassName, className)}>
      <Icon />
      {fullLabel}
    </Badge>
  );
}
