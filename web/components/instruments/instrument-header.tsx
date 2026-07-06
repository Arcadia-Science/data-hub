import Link from "next/link";
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-64" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-[18.4px] w-8 rounded-full" />
          <Skeleton className="h-[18.4px] w-28 rounded-4xl" />
        </div>
      </div>
      <Skeleton className="h-5 w-48" />
    </div>
  );
}

// While an instrument is `pending` its lifecycle state (awaiting admin Confirm)
// is the relevant signal, so it pre-empts the watcher connectivity badge. Once
// active, the watcher badge — linked to the canonical watcher when present —
// takes over.
function renderStatusBadge(
  instrument: InstrumentDetail,
  watcherStatus: WatcherOnlineStatus
) {
  if (instrument.status === "pending") {
    return <InstrumentStatusBadge className="px-2 py-3" status="pending" />;
  }

  const badge = (
    <WatcherStatusBadge
      className="px-2 py-3"
      lastOnlineAt={instrument.lastWatcherHeartbeatAt}
      status={watcherStatus}
      verbose
    />
  );

  if (instrument.activeWatcherId) {
    return (
      <Link
        className="transition-colors hover:opacity-80"
        href={`/watchers/${instrument.activeWatcherId}`}
      >
        {badge}
      </Link>
    );
  }

  return badge;
}

export function InstrumentHeader({
  instrument,
  notifications,
}: {
  instrument: InstrumentDetail;
  /**
   * Per-viewer notification state for this instrument. When omitted
   * (e.g. unauthenticated callers, or contexts that don't want to
   * surface the switch), the action row falls back to the watcher-status
   * layout.
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

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">
          {instrument.displayName}
        </h1>

        <div className="flex items-center gap-2">
          {notifications ? (
            <InstrumentNotificationSwitch
              initialEnabled={notifications.enabled}
              instrumentId={instrument.id}
              masterMuted={notifications.masterMuted}
            />
          ) : null}
          {renderStatusBadge(instrument, watcherStatus)}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
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
  );
}
