"use client";

import {
  CircleAlert,
  CircleCheck,
  Clock,
  Info,
  RotateCw,
  Undo2,
} from "lucide-react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { WatcherNotice } from "@/components/watchers/watcher-notice";
import type {
  ConfigRevision,
  ConfigRevisionStatus,
} from "@/lib/api/watcher-config/revisions";
import { GREEN_BADGE_COLORS, RED_BADGE_COLORS } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import {
  type ConfigNoticeKind,
  pendingChangeAuthor,
  rejectionReasonText,
} from "@/lib/watchers/config-notice";

const STATUS_BADGES: Record<
  ConfigRevisionStatus,
  { label: string; Icon: typeof Clock; className: string }
> = {
  pending: {
    label: "Change pending",
    Icon: Clock,
    className: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  },
  applied: {
    label: "Applied",
    Icon: CircleCheck,
    className: GREEN_BADGE_COLORS,
  },
  rejected: {
    label: "Rejected",
    Icon: CircleAlert,
    className: RED_BADGE_COLORS,
  },
  superseded: {
    label: "Superseded",
    Icon: Undo2,
    className:
      "bg-muted text-muted-foreground dark:bg-slate-950 dark:text-slate-300",
  },
};

export function ConfigRevisionStatusBadge({
  status,
  className,
}: {
  status: ConfigRevisionStatus;
  className?: string;
}) {
  const { label, Icon, className: variant } = STATUS_BADGES[status];
  return (
    <Badge className={cn(variant, className)}>
      <Icon />
      {label}
    </Badge>
  );
}

const RESTART_CLASSNAME =
  "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300";

/** List badge for a PC edit that takes effect when the watcher restarts. */
export function RestartPendingBadge({ className }: { className?: string }) {
  return (
    <Badge className={cn(RESTART_CLASSNAME, className)}>
      <RotateCw />
      Edited on PC, restart pending
    </Badge>
  );
}

/** List badge for a watcher whose latest change is pending or rejected. */
export function ConfigChangeBadge({
  status,
  className,
}: {
  status: ConfigRevisionStatus | null;
  className?: string;
}) {
  if (status === "pending") {
    return (
      <Badge className={cn(STATUS_BADGES.pending.className, className)}>
        <Clock />
        Change pending
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge className={cn(STATUS_BADGES.rejected.className, className)}>
        <CircleAlert />
        Change rejected
      </Badge>
    );
  }
  return null;
}

/**
 * The one notice at the top of the Settings tab for the latest settings state:
 * a change pending (blue), a change the watcher rejected (red, with its
 * reason), or an edit made on the PC that waits for a restart (amber). Applied
 * settings have no notice, so the page doesn't render this for them.
 *
 * `revision` is the one the notice is about: the pending or rejected change,
 * or the PC edit.
 */
export function ConfigStateNotice({
  kind,
  revision,
  viewerUserId,
}: {
  kind: ConfigNoticeKind;
  revision: ConfigRevision;
  viewerUserId: string;
}) {
  const time = <RelativeTime date={revision.createdAt.toISOString()} />;

  if (kind === "pending") {
    return (
      <WatcherNotice icon={Info} title="Change pending" tone="info">
        {pendingChangeAuthor(revision.createdBy, viewerUserId)} saved a change{" "}
        {time}. The watcher picks it up within about a minute, then Current
        settings updates.
      </WatcherNotice>
    );
  }

  if (kind === "rejected") {
    const reason = rejectionReasonText(revision.statusReason);
    return (
      <WatcherNotice icon={CircleAlert} title="Change rejected" tone="danger">
        The watcher couldn&apos;t apply the change saved {time}
        {reason ? `: ${reason}` : ""}. It&apos;s still running its previous
        settings.
      </WatcherNotice>
    );
  }

  return (
    <WatcherNotice
      icon={RotateCw}
      title="Edited on PC — restart pending"
      tone="warning"
    >
      Someone edited the config file on the instrument PC. The change takes
      effect after the watcher restarts.
    </WatcherNotice>
  );
}

/**
 * Explains why Data Hub can't read the config file the watcher pushed. The
 * fix is at the PC: until then, edits made there aren't recorded, and the
 * form has no settings to start from unless a revision exists.
 */
export function UnreadableConfigCallout({
  problem,
  hasSettings,
}: {
  problem: string | null;
  /** Whether the form still has settings to start from. */
  hasSettings: boolean;
}) {
  if (!problem) {
    return null;
  }
  return (
    <Alert>
      <CircleAlert />
      <AlertTitle>
        Data Hub can&apos;t read the watcher&apos;s config file
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span className="break-words font-mono text-xs">{problem}</span>
        <span>
          Fix <code>config.yaml</code> on the instrument PC, for example with{" "}
          <code>data-hub-watcher config edit</code>. Until then, edits made on
          the PC aren&apos;t recorded here
          {hasSettings ? "." : ", and there are no settings to edit here."}
        </span>
      </AlertDescription>
    </Alert>
  );
}
