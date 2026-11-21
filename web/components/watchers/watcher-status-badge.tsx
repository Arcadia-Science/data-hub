"use client";

import { Clock, FolderX, Power, Radio, Unplug, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import {
  AUTO_UPDATE_STATUS_REASON,
  type EffectiveStatus,
  isRestartStopReason,
  type RestartStopReason,
  SYSTEM_SHUTDOWN_STATUS_REASON,
  UPLOAD_REQUEST_REVERT_GRACE_MS,
} from "@/lib/api/watcher-status";
import { formatTime } from "@/lib/date";
import { GREEN_BADGE_COLORS, RED_BADGE_COLORS } from "@/lib/ui-classes";
import { cn, formatRelativeTime } from "@/lib/utils";

/**
 * Every status this badge can render: the per-watcher state on the watchers
 * table and the watcher page's header, and `deregistered` for a past watcher.
 * The instrument's own badge, for scientists, is `InstrumentBadge`.
 *
 * `watching` reads "Online" and `stale` reads "Unresponsive", since the badge
 * knows why a watcher is silent.
 */
export type WatcherBadgeStatus = EffectiveStatus | "deregistered";

const ONLINE_CLASSNAME = GREEN_BADGE_COLORS;

const OFFLINE_CLASSNAME = RED_BADGE_COLORS;

// The badge's default variant sets a blue fill for dark mode, and `bg-muted`
// alone doesn't replace that one, so the dark fill is set here as well. It is
// the neutral dark fill of the instrument badge's Restarting and Connecting.
const MUTED_FILLED_CLASSNAME =
  "bg-muted text-muted-foreground dark:bg-slate-950 dark:text-slate-300";

const WARNING_CLASSNAME =
  "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";

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
  deregistered: {
    label: "Deregistered",
    Icon: Unplug,
    className: MUTED_NEUTRAL_CLASSNAME,
  },
  watching: { label: "Online", Icon: Radio, className: ONLINE_CLASSNAME },
  stale: {
    label: "Unresponsive",
    Icon: WifiOff,
    className: OFFLINE_CLASSNAME,
  },
  // Distinct from `stale`: someone (or the host) shut the watcher down
  // gracefully, so it's expected to be silent and shouldn't read as an alarm.
  // A stop for a restart turns `stale` if the watcher isn't back in time, and
  // its tooltip says when.
  stopped: { label: "Stopped", Icon: Power, className: MUTED_FILLED_CLASSNAME },
  // Running and heartbeating, but the watch folder is missing, so nothing is
  // being watched. The watcher keeps checking for the folder and for config
  // changes from Data Hub.
  waiting: {
    label: "Waiting: folder not found",
    Icon: FolderX,
    className: WARNING_CLASSNAME,
  },
  // Registered but hasn't sent its first heartbeat yet. It turns `stale` if
  // none arrives in time (see `FIRST_CHECK_IN_GRACE_MS`).
  registered: {
    label: "Registered",
    Icon: Clock,
    className: MUTED_NEUTRAL_CLASSNAME,
  },
};

// Statuses where the watcher *should* be reporting but isn't, so the tooltip
// explains the check-in delay. Excludes `stopped` (intentional) and
// `registered` (no heartbeat history yet). A `stopped` badge gets a tooltip
// only for a stop after which the watcher is expected back (see
// `RESTART_STOP_REASONS`). That tooltip says when the watcher starts to read
// as unresponsive, and it is built separately below.
const TOOLTIP_STATUSES = new Set<WatcherBadgeStatus>(["stale"]);

const RESTART_STOP_LEAD: Record<RestartStopReason, string> = {
  [SYSTEM_SHUTDOWN_STATUS_REASON]: "Stopped for a Windows restart or shutdown.",
  [AUTO_UPDATE_STATUS_REASON]: "Stopped to install an automatic update.",
};

export function WatcherStatusBadge({
  status,
  lastOnlineAt,
  reason,
  className,
}: {
  status: WatcherBadgeStatus;
  /**
   * Why a `waiting` watcher is waiting, or why a `stopped` watcher stopped
   * for a restart. Shown in its tooltip.
   */
  reason?: string | null;
  /**
   * Most recent watcher heartbeat. When the badge is in an "unexpected
   * silence" state (`stale`), the tooltip leads with it so users can tell at
   * a glance how long the watcher has been silent, and without it the tooltip
   * says the watcher never checked in. For a watcher that stopped for a
   * restart, it sets the time the tooltip gives for when the watcher starts to
   * read as unresponsive.
   */
  lastOnlineAt?: Date | null;
  className?: string;
}) {
  const timeZone = useViewerTimeZone();
  const { label, Icon, className: variantClassName } = STATUS_CONFIG[status];

  const badge = (
    <Badge className={cn(variantClassName, className)}>
      <Icon />
      {label}
    </Badge>
  );

  if (status === "waiting") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="flex max-w-80 flex-col items-start gap-0.5">
          {reason ? <p className="break-all font-medium">{reason}</p> : null}
          <p>
            The watcher is running but can&apos;t find its watch folder. Fix the
            folder on the PC, or change it on the watcher&apos;s Settings tab.
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (status === "stopped" && isRestartStopReason(reason) && lastOnlineAt) {
    const unresponsiveAt = new Date(
      lastOnlineAt.getTime() + UPLOAD_REQUEST_REVERT_GRACE_MS
    );
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="max-w-80">
          {RESTART_STOP_LEAD[reason]} Shows as Unresponsive if it isn&apos;t
          back by {formatTime(unresponsiveAt, timeZone)}.
        </TooltipContent>
      </Tooltip>
    );
  }

  if (!TOOLTIP_STATUSES.has(status)) {
    return badge;
  }

  // Only a `registered` watcher past its time limit reads `stale` without ever
  // having sent a heartbeat.
  if (!lastOnlineAt) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="flex max-w-80 flex-col items-start gap-0.5">
          <p className="font-medium">Never checked in</p>
          <p>
            The watcher was set up but hasn&apos;t sent its first check-in.
            Start the watcher service on the PC and check that it can reach Data
            Hub.
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="flex flex-col items-start gap-0.5">
        <p className="font-medium">
          Last online {formatRelativeTime(lastOnlineAt)}
        </p>
        <p>
          The watcher checks in with Data Hub once a minute. If it was just
          restarted, it can take up to a minute to show as online. Refresh the
          page to see the latest status.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
