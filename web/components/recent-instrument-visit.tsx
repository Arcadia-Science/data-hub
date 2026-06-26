"use client";

import { useEffect } from "react";
import { useRecentInstruments } from "@/hooks/use-recent-instruments";

export function RecordInstrumentVisit({
  instrumentId,
  displayName,
}: {
  instrumentId: string;
  displayName: string;
}) {
  const { recordVisit } = useRecentInstruments();

  useEffect(() => {
    recordVisit({
      instrumentId,
      displayName,
      visitedAt: Date.now(),
    });
  }, [displayName, instrumentId, recordVisit]);

  return null;
}
