"use client";

import { ArrowRight, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import { formatLastCheckIn } from "@/lib/instruments/problem-notice";
import {
  offlineNoticeCopy,
  shouldShowOfflineNotice,
} from "@/lib/runs/offline-notice";
import { useWatcherStatus } from "./watcher-status-provider";

/**
 * Tells the viewer that files from this run are stuck on the instrument PC
 * because its watcher is offline. It sits between the run details and the
 * Files section, and shows only for an Offline instrument and a run with
 * waiting files (see `shouldShowOfflineNotice`). `waitingFileCount` is the
 * run's files that are detected or upload requested.
 */
export function RunOfflineNotice({
  waitingFileCount,
}: {
  waitingFileCount: number;
}) {
  const { badgeState, instrumentId, instrumentName, lastHeartbeatAt } =
    useWatcherStatus();
  const timeZone = useViewerTimeZone();
  const titleId = useId();

  if (!shouldShowOfflineNotice(badgeState, waitingFileCount)) {
    return null;
  }

  const { title, body } = offlineNoticeCopy({
    waitingFileCount,
    instrumentName,
    lastCheckIn: lastHeartbeatAt
      ? formatLastCheckIn(lastHeartbeatAt, timeZone)
      : null,
  });

  return (
    <section
      aria-labelledby={titleId}
      className="flex gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5 text-red-900 text-sm dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-px size-[18px] shrink-0 text-red-700 dark:text-red-400"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-semibold" id={titleId}>
          {title}
        </p>
        {/* "today" and "yesterday" come from the clock, which differs between
            the server render and hydration around midnight. */}
        <p suppressHydrationWarning>{body}</p>
        <Link
          className="inline-flex w-fit items-center gap-1 rounded-sm font-medium underline underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={`/instruments/${encodeURIComponent(instrumentId)}/watcher`}
        >
          See details
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
    </section>
  );
}
