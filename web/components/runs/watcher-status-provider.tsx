"use client";

import { createContext, type ReactNode, use, useMemo } from "react";
import type { InstrumentBadgeState } from "@/lib/instruments/connection";
import {
  getRunUploadAvailability,
  type RunUploadAvailability,
} from "@/lib/runs/upload-availability";

/**
 * What the run page knows about the instrument's watcher: the badge the
 * instrument shows (which lets Pending and Retired win over the connection),
 * and what the offline notice says about the instrument.
 */
export interface WatcherStatus {
  badgeState: InstrumentBadgeState;
  instrumentId: string;
  instrumentName: string;
  /** When the watcher last checked in, or null if it never has. */
  lastHeartbeatAt: Date | null;
  /** Whether Upload works now, and the line that says why not. */
  upload: RunUploadAvailability;
}

type WatcherStatusInput = Omit<WatcherStatus, "upload">;

const WatcherStatusContext = createContext<WatcherStatus | null>(null);

/**
 * Downstream upload controls and the offline notice read this. They follow the
 * run-page table in `getRunUploadAvailability`, so none of them takes the
 * instrument's state as a prop.
 */
export function WatcherStatusProvider({
  badgeState,
  children,
  instrumentId,
  instrumentName,
  lastHeartbeatAt,
}: WatcherStatusInput & { children: ReactNode }) {
  const value = useMemo<WatcherStatus>(
    () => ({
      badgeState,
      instrumentId,
      instrumentName,
      lastHeartbeatAt,
      upload: getRunUploadAvailability(badgeState),
    }),
    [badgeState, instrumentId, instrumentName, lastHeartbeatAt]
  );
  return (
    <WatcherStatusContext.Provider value={value}>
      {children}
    </WatcherStatusContext.Provider>
  );
}

export function useWatcherStatus(): WatcherStatus {
  const context = use(WatcherStatusContext);
  if (!context) {
    throw new Error(
      "useWatcherStatus must be used within a <WatcherStatusProvider>"
    );
  }
  return context;
}
