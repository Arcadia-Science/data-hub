"use client";

import { FolderOpen } from "lucide-react";
import Link from "next/link";
import { FilePatterns } from "@/components/instruments/file-patterns";
import { InstrumentActions } from "@/components/instruments/instrument-actions";
import { InstrumentStatusBadge } from "@/components/instruments/instrument-status-badge";
import { InstrumentNotificationSwitch } from "@/components/notifications/instrument-notification-switch";
import { RecordInstrumentVisit } from "@/components/recent-instrument-visit";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import {
  getWatcherOnlineStatus,
  type WatcherOnlineStatus,
} from "@/components/watchers/watcher-online-status";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import type { InstrumentDetail } from "@/lib/api/instruments";
import { formatDate } from "@/lib/date";

// Must stay a client component: the retired-by line's `formatDate` resolves the
// timezone at runtime, so server rendering would use UTC and can land the date
// on the wrong calendar day near midnight.
export function InstrumentHeaderSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading instrument"
      className="flex flex-col gap-2"
      role="status"
    >
      <Skeleton className="mb-2 h-4 w-56" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-5 w-72" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>
    </div>
  );
}

// For `pending`/`inactive` instruments the lifecycle badge pre-empts the
// watcher badge, since "No Watcher"/"Offline" would read as a fault rather than
// an intentional decommission.
function renderStatusBadge(
  instrument: InstrumentDetail,
  watcherStatus: WatcherOnlineStatus
) {
  if (instrument.status === "pending" || instrument.status === "inactive") {
    return <InstrumentStatusBadge status={instrument.status} />;
  }

  return (
    <WatcherStatusBadge
      lastOnlineAt={instrument.lastWatcherHeartbeatAt}
      status={
        instrument.activeWatcherDeregistered ? "deregistered" : watcherStatus
      }
    />
  );
}

function WatchDirectory({
  path,
  hostname,
}: {
  path: string;
  hostname: string | null;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex min-w-0 cursor-default items-center gap-1.5"
          tabIndex={0}
        >
          <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only">Watched folder: </span>
          <span className="break-all font-mono text-[13px]">{path}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start" side="bottom">
        <p className="font-medium">
          Watched folder{hostname ? ` on ${hostname}` : ""}
        </p>
        <p>
          The watcher only looks for files in this folder. Files saved anywhere
          else, such as a shared network drive, won't appear in Data Hub.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

export function InstrumentHeader({
  instrument,
  notifications,
  isAdmin = false,
}: {
  instrument: InstrumentDetail;
  /** Admins get the actions menu (edit, watcher, retire / reactivate). */
  isAdmin?: boolean;
  /**
   * Per-viewer notification state for this instrument. When omitted
   * (e.g. unauthenticated callers, or contexts that don't want to
   * surface the switch), the notifications control is hidden.
   */
  notifications?: {
    enabled: boolean;
    masterMuted: boolean;
  };
}) {
  const watcherStatus = getWatcherOnlineStatus(instrument);
  const watchDirectory = instrument.activeWatcherWatchDirectory;
  const retiredAt =
    instrument.status === "inactive" ? instrument.retiredAt : null;

  return (
    <div className="flex flex-col gap-2">
      <RecordInstrumentVisit
        displayName={instrument.displayName}
        instrumentId={instrument.id}
      />
      <Breadcrumb className="mb-2">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/instruments">Instruments</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{instrument.displayName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="font-semibold text-2xl tracking-tight">
              {instrument.displayName}
            </h1>
            {renderStatusBadge(instrument, watcherStatus)}
          </div>

          {watchDirectory || retiredAt ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
              {watchDirectory ? (
                <>
                  <WatchDirectory
                    hostname={instrument.activeWatcherHostname}
                    path={watchDirectory}
                  />
                  {instrument.filePatterns.length > 0 ? (
                    <FilePatterns patterns={instrument.filePatterns} />
                  ) : null}
                </>
              ) : null}
              {retiredAt ? (
                <>
                  {watchDirectory ? <span>·</span> : null}
                  <span className="flex items-center gap-1.5">
                    <span>Retired {formatDate(retiredAt)}</span>
                    {instrument.retiredByUser ? (
                      <span className="flex items-center gap-1.5">
                        <span>by</span>
                        <UserAvatar size="sm" user={instrument.retiredByUser} />
                        <span className="font-medium text-foreground">
                          {instrument.retiredByUser.displayName}
                        </span>
                      </span>
                    ) : null}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Retired/pending instruments emit no new runs, so the subscribe
              pill would be a dead control — hide it outside the active state
              (matches `/settings/notifications`, which lists active only). */}
          {notifications && instrument.status === "active" ? (
            <InstrumentNotificationSwitch
              initialEnabled={notifications.enabled}
              instrumentId={instrument.id}
              masterMuted={notifications.masterMuted}
              size="sm"
              variant="button"
            />
          ) : null}
          {isAdmin ? (
            <InstrumentActions instrument={instrument} variant="expanded" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
