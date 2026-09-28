"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";

// Polling stops `AUTO_REFRESH_WINDOW_MS` after in-flight files first appear
// or the last `restart`, not after the last status change. A file stuck in
// `upload_requested` or `processing` then can't keep a tab refreshing.
const AUTO_REFRESH_INTERVAL_MS = 5000;
const AUTO_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const AUTO_REFRESH_TOAST_ID = "run-auto-refresh-stopped";

interface RunAutoRefreshContextValue {
  actions: {
    restart: () => void;
  };
}

const RunAutoRefreshContext = createContext<RunAutoRefreshContextValue | null>(
  null
);

export function RunAutoRefreshProvider({
  children,
  hasInFlight,
}: {
  children: React.ReactNode;
  // A boolean, not the stats object: each refresh builds a new stats object,
  // and this effect must not restart just because that object's identity changed.
  hasInFlight: boolean;
}) {
  const router = useRouter();
  // Null until files are in flight or `restart` runs, so an idle page never
  // starts the window. Held in state so changing it restarts the timer effect.
  const [windowStartedAt, setWindowStartedAt] = useState<number | null>(null);

  // Arm the window during render so polling starts on that same commit.
  if (hasInFlight && windowStartedAt === null) {
    setWindowStartedAt(Date.now());
  }

  const restart = useCallback(() => {
    setWindowStartedAt(Date.now());
  }, []);

  const value = useMemo<RunAutoRefreshContextValue>(
    () => ({ actions: { restart } }),
    [restart]
  );

  useEffect(() => {
    if (!hasInFlight || windowStartedAt === null) {
      return;
    }

    const showStoppedToast = () => {
      toast("Stopped checking for file updates", {
        id: AUTO_REFRESH_TOAST_ID,
        description: "Statuses on this page may be out of date.",
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        action: {
          label: "Refresh",
          onClick: () => {
            restart();
            router.refresh();
          },
        },
      });
    };

    // This effect can run again after the window has already elapsed, for
    // example when `hasInFlight` flips back to true. Show the toast without
    // refreshing again.
    const remaining = AUTO_REFRESH_WINDOW_MS - (Date.now() - windowStartedAt);
    if (remaining <= 0) {
      showStoppedToast();
      return () => {
        toast.dismiss(AUTO_REFRESH_TOAST_ID);
      };
    }

    const intervalId = setInterval(() => {
      // A background tab would spend the whole window on refreshes nobody sees.
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, AUTO_REFRESH_INTERVAL_MS);
    const timeoutId = setTimeout(() => {
      clearInterval(intervalId);
      showStoppedToast();
    }, remaining);

    return () => {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      toast.dismiss(AUTO_REFRESH_TOAST_ID);
    };
  }, [hasInFlight, windowStartedAt, router, restart]);

  return (
    <RunAutoRefreshContext.Provider value={value}>
      {children}
    </RunAutoRefreshContext.Provider>
  );
}

export function useRunAutoRefresh(): RunAutoRefreshContextValue {
  const ctx = use(RunAutoRefreshContext);
  if (!ctx) {
    throw new Error(
      "useRunAutoRefresh must be used within a RunAutoRefreshProvider"
    );
  }
  return ctx;
}
