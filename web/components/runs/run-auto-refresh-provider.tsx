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

// A run page used to call `router.refresh()` for as long as any file stayed
// in `upload_requested`. A file that can never finish kept the tab refreshing,
// and each refresh made the browser prefetch every visible link. The window
// is five minutes from when this provider mounts, not from the last status
// change, so a stuck upload stops on its own.
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
  // State, not a ref: changing it is what restarts the timer effect.
  const [windowStartedAt, setWindowStartedAt] = useState(() => Date.now());

  const restart = useCallback(() => {
    setWindowStartedAt(Date.now());
  }, []);

  const value = useMemo<RunAutoRefreshContextValue>(
    () => ({ actions: { restart } }),
    [restart]
  );

  useEffect(() => {
    if (!hasInFlight) {
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

    // A filter change after the window can bring in-progress files back.
    // Show the toast immediately instead of refreshing once more.
    const remaining = AUTO_REFRESH_WINDOW_MS - (Date.now() - windowStartedAt);
    if (remaining <= 0) {
      showStoppedToast();
      return () => {
        toast.dismiss(AUTO_REFRESH_TOAST_ID);
      };
    }

    const intervalId = setInterval(() => {
      router.refresh();
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
