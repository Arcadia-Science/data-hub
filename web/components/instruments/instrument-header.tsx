import Link from "next/link";
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
  getWatcherOnlineStatus,
  type WatcherOnlineStatus,
} from "@/components/watchers/watcher-online-status";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import type { InstrumentDetail } from "@/lib/api/instruments";

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
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-5 w-72" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-8 w-36 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>
    </div>
  );
}

// For `pending`/`inactive` instruments the lifecycle badge pre-empts the
// watcher badge, since "No Watcher"/"Offline" would read as a fault rather than
// an intentional decommission. The hostname beside it links to the watcher.
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

export function InstrumentHeader({
  instrument,
  notifications,
  isAdmin = false,
}: {
  instrument: InstrumentDetail;
  /** Admins get the inline Edit / Retire / Reactivate actions. */
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
          <h1 className="font-semibold text-2xl tracking-tight">
            {instrument.displayName}
          </h1>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
            {renderStatusBadge(instrument, watcherStatus)}
            <span>·</span>
            <span>
              {instrument.runCount} {instrument.runCount === 1 ? "run" : "runs"}
            </span>
            {instrument.activeWatcherId && instrument.activeWatcherHostname ? (
              <>
                <span>·</span>
                <Link
                  className="hover:text-foreground hover:underline"
                  href={`/watchers/${instrument.activeWatcherId}`}
                >
                  {instrument.activeWatcherHostname}
                </Link>
              </>
            ) : null}
          </div>
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
