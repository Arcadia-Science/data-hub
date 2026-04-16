import { Badge } from "@/components/ui/badge";
import { DeregisterDialog } from "@/components/watchers/deregister-dialog";
import { statusBadge } from "@/components/watchers/status-badge";
import type { WatcherDetail } from "@/lib/api/watchers";
import { formatDate } from "@/lib/date";
import { formatRelativeTime } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export function WatcherHeader({ watcher }: { watcher: WatcherDetail }) {
  const sb = statusBadge[watcher.effectiveStatus];
  const isDeregistered = !!watcher.deletedAt;

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/watchers"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to watchers
      </Link>

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
            <Badge variant={sb.variant} className="text-[10px]">
              {sb.label}
            </Badge>
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

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{watcher.id}</span>
          <span>·</span>
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
