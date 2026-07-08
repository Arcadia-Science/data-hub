"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Skeleton } from "@/components/ui/skeleton";
import { DeregisterDialog } from "@/components/watchers/deregister-dialog";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import type { WatcherDetail } from "@/lib/api/watchers";
import { formatDate } from "@/lib/date";
import { formatRelativeTime } from "@/lib/utils";

// Must stay a client component: `formatDate` resolves the timezone at runtime,
// so server rendering uses UTC and can land a date on the wrong calendar day
// near midnight.
export function WatcherHeaderSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading watcher"
      className="flex flex-col gap-4"
      role="status"
    >
      <Skeleton className="h-4 w-56" />
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
          <Skeleton className="h-7 w-24" />
        </div>
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
    </div>
  );
}

export function WatcherHeader({ watcher }: { watcher: WatcherDetail }) {
  const isDeregistered = !!watcher.deletedAt;

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/watchers">Watchers</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              {watcher.hostname ?? "Unnamed Watcher"}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Deregistration is signalled by the badge and date below, not by
          fading the header (which made the text too faint to read). */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h1 className="font-semibold text-2xl tracking-tight">
              {watcher.hostname ?? "Unnamed Watcher"}
            </h1>
            <WatcherStatusBadge
              lastOnlineAt={watcher.lastHeartbeatAt}
              status={watcher.effectiveStatus}
            />
            {watcher.watcherVersion && (
              <Badge className="font-mono text-xs" variant="outline">
                v{watcher.watcherVersion}
              </Badge>
            )}
            {isDeregistered && <Badge variant="secondary">Deregistered</Badge>}
          </div>

          {!isDeregistered && (
            <DeregisterDialog
              hostname={watcher.hostname}
              watcherId={watcher.id}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
          <Link
            className="hover:text-foreground hover:underline"
            href={`/instruments/${watcher.instrumentId}`}
          >
            {watcher.instrumentDisplayName ?? watcher.instrumentId}
          </Link>
          {watcher.osInfo && (
            <>
              <span>·</span>
              <span>{watcher.osInfo}</span>
            </>
          )}
          {watcher.lastHeartbeatAt && (
            <>
              <span>·</span>
              <span>
                Last heartbeat {formatRelativeTime(watcher.lastHeartbeatAt)}
              </span>
            </>
          )}
          {isDeregistered && watcher.deletedAt && (
            <>
              <span>·</span>
              <span>Deregistered {formatDate(watcher.deletedAt)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
