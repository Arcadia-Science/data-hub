import Link from "next/link";
import type { ReactNode } from "react";
import type { DateRange } from "@/components/runs/runs-date-filter";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectivityGrid } from "@/components/watchers/connectivity-grid";
import { FilesPerDayChart } from "@/components/watchers/files-per-day-chart";
import { WatcherRangeFilter } from "@/components/watchers/watcher-range-filter";
import { getWatcherHealth } from "@/lib/api/watcher-health";
import {
  failuresNote,
  filesNote,
  missedNote,
  restartsNote,
} from "@/lib/watchers/health";
import {
  rangeDates,
  rangeTitle,
  type WatcherRange,
} from "@/lib/watchers/range";

export function WatcherHealthSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading health"
      className="flex flex-col gap-4"
      role="status"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        {["files", "failures", "restarts", "missed"].map((card) => (
          <Skeleton className="h-[110px] rounded-xl" key={card} />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

function CountCard({
  label,
  value,
  note,
}: {
  label: string;
  value: number;
  note: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card px-5 py-4">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="font-semibold text-[28px] tabular-nums leading-9">
        {value}
      </span>
      <span className="text-muted-foreground text-sm">{note}</span>
    </div>
  );
}

/**
 * The Health tab: the selected watcher over a range of days. The page reads the
 * range's counts and heartbeats here, so nothing is read until this tab opens.
 */
export async function WatcherHealth({
  watcherId,
  range,
  rangeFallback,
  timeZone,
  deregisteredAt,
  failuresHref,
}: {
  watcherId: string;
  range: WatcherRange;
  /** What the range picker shows when the URL names no range. */
  rangeFallback: DateRange;
  timeZone: string;
  /** When the watcher was deregistered, for a past watcher. */
  deregisteredAt: Date | null;
  /** The Activity tab, filtered to this range's upload failures. */
  failuresHref: string;
}) {
  const now = new Date();
  const health = await getWatcherHealth(watcherId, {
    fromDay: range.fromDay,
    toDay: range.toDay,
    start: range.start,
    endExclusive: range.endExclusive,
    timeZone,
    deregisteredAt,
    now,
  });
  const { totals } = health;
  const words = { range, timeZone, now };

  return (
    <TablePendingProvider>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{rangeTitle(range, timeZone, now)}</h2>
          <WatcherRangeFilter fallback={rangeFallback} />
        </div>
        {range.wasCut ? (
          <p className="text-muted-foreground text-sm">
            Health shows up to {range.dayCount} days at a time, so this is the
            last {range.dayCount} days of the range you picked.
          </p>
        ) : null}

        <TablePendingBoundary>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
              <CountCard
                label="Files uploaded"
                note={filesNote(totals, words)}
                value={totals.files}
              />
              <CountCard
                label="Upload failures"
                note={
                  failuresNote(totals.uploadFailures, words) ?? (
                    <Link
                      className="font-medium text-foreground underline underline-offset-3"
                      href={failuresHref}
                    >
                      See them in Activity
                    </Link>
                  )
                }
                value={totals.uploadFailures}
              />
              <CountCard
                label="Restarts"
                note={restartsNote(totals.restarts, words)}
                value={totals.restarts.update + totals.restarts.windows}
              />
              <CountCard
                label="Missed heartbeats"
                note={missedNote(totals, words)}
                value={totals.missedHeartbeats}
              />
            </div>

            <section className="flex flex-col gap-4 rounded-xl border bg-card p-5">
              <div>
                <h3 className="font-semibold">Files uploaded per day</h3>
                <p className="text-muted-foreground text-sm">
                  {rangeDates(range, timeZone, now)}
                </p>
              </div>
              <FilesPerDayChart days={health.days} />
            </section>

            <section className="rounded-xl border bg-card p-5">
              <ConnectivityGrid days={health.days} />
            </section>
          </div>
        </TablePendingBoundary>
      </div>
    </TablePendingProvider>
  );
}
