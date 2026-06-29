import Link from "next/link";
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
import { getWatcherOnlineStatus } from "@/components/watchers/watcher-online-status";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import type { InstrumentDetail } from "@/lib/api/instruments";

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
          {instrument.activeWatcherId ? (
            <Link href={`/watchers/${instrument.activeWatcherId}`}>
              <WatcherStatusBadge
                className="px-2 py-3 transition-colors hover:opacity-80"
                lastOnlineAt={instrument.lastWatcherHeartbeatAt}
                status={watcherStatus}
                verbose
              />
            </Link>
          ) : (
            <WatcherStatusBadge
              className="px-2 py-3"
              lastOnlineAt={instrument.lastWatcherHeartbeatAt}
              status={watcherStatus}
              verbose
            />
          )}
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
