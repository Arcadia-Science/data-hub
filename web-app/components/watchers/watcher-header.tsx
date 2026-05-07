import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { DeregisterDialog } from "@/components/watchers/deregister-dialog";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import type { WatcherDetail } from "@/lib/api/watchers";
import { formatDate } from "@/lib/date";
import { formatRelativeTime } from "@/lib/utils";
import Link from "next/link";

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

      {/* Deregistered watchers get a muted, dashed-border treatment to
          visually signal that this is historical data. The deregister action
          is hidden since the watcher is already soft-deleted. */}
      <div
        className={
          isDeregistered
            ? "flex flex-col gap-3 rounded-lg border border-dashed p-4 opacity-70"
            : "flex flex-col gap-3"
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {watcher.hostname ?? "Unnamed Watcher"}
            </h1>
            <WatcherStatusBadge
              status={watcher.effectiveStatus}
              lastOnlineAt={watcher.lastHeartbeatAt}
            />
            {watcher.watcherVersion && (
              <Badge variant="outline" className="font-mono text-[10px]">
                v{watcher.watcherVersion}
              </Badge>
            )}
            {isDeregistered && (
              <Badge variant="secondary" className="text-[10px]">
                Deregistered
              </Badge>
            )}
          </div>

          {!isDeregistered && (
            <DeregisterDialog
              watcherId={watcher.id}
              hostname={watcher.hostname}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <Link
            href={`/instruments/${watcher.instrumentId}`}
            className="hover:text-foreground hover:underline"
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
