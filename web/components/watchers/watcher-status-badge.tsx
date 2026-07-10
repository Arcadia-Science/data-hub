"use client";

import { Clock, Power, Radio, Unplug, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WatcherOnlineStatus } from "@/components/watchers/watcher-online-status";
import type { EffectiveStatus } from "@/lib/api/watchers";
import { cn, formatRelativeTime } from "@/lib/utils";

/**
 * Union of every status this badge can render:
 *   - `WatcherOnlineStatus` is the instrument-level aggregate (any watcher
 *     online vs none) used in the instruments table and instrument header.
 *   - `EffectiveStatus` is the per-watcher state used in the watchers table
 *     and watcher detail header.
 *
 * `watching` and `online` collapse to the same green "Online" treatment;
 * `stale` and `offline` collapse to the same destructive treatment but with
 * different labels ("Unresponsive" vs "Offline") since the aggregate badge
 * can't tell why an instrument's watchers are silent, while the per-watcher
 * badge can.
 */
export type WatcherBadgeStatus =
  | WatcherOnlineStatus
  | EffectiveStatus
  // Active instrument whose only watcher was deregistered. Distinct from
  // `no_watcher` (never had one), so the header can still link to the watcher.
  | "deregistered";

const ONLINE_CLASSNAME =
  "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300";

const OFFLINE_CLASSNAME =
  "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";

const MUTED_FILLED_CLASSNAME = "bg-muted text-muted-foreground";

const MUTED_NEUTRAL_CLASSNAME =
  "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300";

const STATUS_CONFIG: Record<
  WatcherBadgeStatus,
  {
    label: string;
    Icon: typeof Radio;
    className: string;
  }
> = {
  // Instrument-level aggregate
  online: { label: "Online", Icon: Radio, className: ONLINE_CLASSNAME },
  offline: { label: "Offline", Icon: WifiOff, className: OFFLINE_CLASSNAME },
  no_watcher: {
    label: "No Watcher",
    Icon: WifiOff,
    className: MUTED_NEUTRAL_CLASSNAME,
  },
  deregistered: {
    label: "Deregistered",
    Icon: Unplug,
    className: MUTED_NEUTRAL_CLASSNAME,
  },
  // Per-watcher
  watching: { label: "Online", Icon: Radio, className: ONLINE_CLASSNAME },
  stale: {
    label: "Unresponsive",
    Icon: WifiOff,
    className: OFFLINE_CLASSNAME,
  },
  // Distinct from `stale`: someone (or the host) shut the watcher down
  // gracefully, so it's expected to be silent and shouldn't read as an alarm.
  stopped: { label: "Stopped", Icon: Power, className: MUTED_FILLED_CLASSNAME },
  // Registered but hasn't sent its first heartbeat yet — transient.
  registered: {
    label: "Registered",
    Icon: Clock,
    className: MUTED_NEUTRAL_CLASSNAME,
  },
};

// Statuses where a "last online at" tooltip makes sense — i.e. the watcher
// *should* be reporting but isn't. Excludes `stopped` (intentional) and
// `registered` (no heartbeat history yet).
const TOOLTIP_STATUSES = new Set<WatcherBadgeStatus>(["offline", "stale"]);

export function WatcherStatusBadge({
  status,
  lastOnlineAt,
  verbose = false,
  className,
}: {
  status: WatcherBadgeStatus;
  /**
   * Most recent watcher heartbeat. When the badge is in an "unexpected
   * silence" state (`offline` / `stale`) and this is provided, it's
   * surfaced via tooltip so users can tell at a glance how long the
   * watcher has been silent.
   */
  lastOnlineAt?: Date | null;
  /**
   * When true, prefixes the aggregate online/offline labels with "Watcher"
   * (e.g. "Watcher Online"). Useful in headers where the badge stands alone
   * outside a status column. Has no effect on per-watcher labels or on
   * `no_watcher`, where prefixing would be redundant or wrong.
   */
  verbose?: boolean;
  className?: string;
}) {
  const { label, Icon, className: variantClassName } = STATUS_CONFIG[status];
  const fullLabel =
    verbose && (status === "online" || status === "offline")
      ? `Watcher ${label}`
      : label;

  const badge = (
    <Badge className={cn(variantClassName, className)}>
      <Icon />
      {fullLabel}
    </Badge>
  );

  if (!(TOOLTIP_STATUSES.has(status) && lastOnlineAt)) {
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
