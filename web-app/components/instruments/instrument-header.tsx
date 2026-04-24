import { Badge } from "@/components/ui/badge";
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
import Link from "next/link";

export function InstrumentHeader({
  instrument,
}: {
  instrument: InstrumentDetail;
}) {
  const watcherStatus = getWatcherOnlineStatus(instrument);

  return (
    <div className="flex flex-col gap-2">
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
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {instrument.displayName}
          </h1>
        </div>

        <div className="flex items-center gap-2">
          {instrument.activeWatcherId ? (
            <Link href={`/watchers/${instrument.activeWatcherId}`}>
              <WatcherStatusBadge
                status={watcherStatus}
                lastOnlineAt={instrument.lastWatcherHeartbeatAt}
                verbose
                className="px-2 py-3 transition-colors hover:opacity-80"
              />
            </Link>
          ) : (
            <WatcherStatusBadge
              status={watcherStatus}
              lastOnlineAt={instrument.lastWatcherHeartbeatAt}
              verbose
              className="px-2 py-3"
            />
          )}
          <Badge variant="outline" className="px-2 py-3 font-mono text-xs">
            {instrument.runCount} {instrument.runCount === 1 ? "run" : "runs"}
          </Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-muted-foreground">
          {instrument.id}
        </span>
      </div>
    </div>
  );
}
