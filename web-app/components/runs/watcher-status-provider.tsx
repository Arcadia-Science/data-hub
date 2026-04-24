"use client";

import { createContext, use, type ReactNode } from "react";

/**
 * Describes whether the instrument's watcher is actively heartbeating.
 *
 * Downstream upload-style controls read this to decide between the
 * enabled button and the disabled-with-tooltip variant (see
 * `watcher-gated-upload-button.tsx`). Centralizing the flag here keeps
 * the run-detail variants free of `isWatcherOnline` prop drilling.
 */
export type WatcherStatus = {
  isWatcherOnline: boolean;
};

const WatcherStatusContext = createContext<WatcherStatus | null>(null);

export function WatcherStatusProvider({
  isWatcherOnline,
  children,
}: {
  isWatcherOnline: boolean;
  children: ReactNode;
}) {
  return (
    <WatcherStatusContext.Provider value={{ isWatcherOnline }}>
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
