"use client";

import { useEffect } from "react";
import {
  useRecentWatchers,
  watcherNavLabel,
} from "@/hooks/use-recent-watchers";

export function RecordWatcherVisit({
  watcherId,
  hostname,
}: {
  watcherId: string;
  hostname: string | null;
}) {
  const { recordVisit } = useRecentWatchers();
  const label = watcherNavLabel(watcherId, hostname);

  useEffect(() => {
    recordVisit({
      watcherId,
      label,
      visitedAt: Date.now(),
    });
  }, [label, recordVisit, watcherId]);

  return null;
}
