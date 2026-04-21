"use client";

import { cn } from "@/lib/utils";
import {
  type ReactNode,
  type TransitionStartFunction,
  createContext,
  useContext,
  useEffect,
  useState,
  useTransition,
} from "react";

type TablePendingContextValue = {
  // Instantaneous transition state from React. Use this for logic that should
  // react immediately (e.g. blocking double-clicks on pagination).
  isPending: boolean;
  // Debounced pending state that only flips true after `delayMs`. Use this for
  // visible UI (opacity, cursor, progress bar) so that fast fetches don't
  // flicker a loading state on screen.
  isPendingVisible: boolean;
  // Pass this into nuqs `withOptions({ startTransition })` so URL updates are
  // tracked as React transitions.
  startTransition: TransitionStartFunction;
};

const noopStartTransition: TransitionStartFunction = (cb) => cb();

const TablePendingContext = createContext<TablePendingContextValue>({
  isPending: false,
  isPendingVisible: false,
  startTransition: noopStartTransition,
});

export function TablePendingProvider({
  children,
  delayMs = 120,
}: {
  children: ReactNode;
  delayMs?: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [isPendingVisible, setIsPendingVisible] = useState(false);

  // The visible state is only ever flipped inside async callbacks (setTimeout
  // on entry, cleanup on exit). This keeps the setState out of the effect body
  // itself, avoiding cascading render warnings.
  useEffect(() => {
    if (!isPending) return;
    const id = setTimeout(() => setIsPendingVisible(true), delayMs);
    return () => {
      clearTimeout(id);
      setIsPendingVisible(false);
    };
  }, [isPending, delayMs]);

  return (
    <TablePendingContext.Provider
      value={{ isPending, isPendingVisible, startTransition }}
    >
      {children}
    </TablePendingContext.Provider>
  );
}

export function useTablePending(): TablePendingContextValue {
  return useContext(TablePendingContext);
}

// Wraps a table (or other server-rendered content) and applies the shared
// "stale data" treatment while a navigation is in flight: dim the content,
// block interaction, show a thin indeterminate progress bar on top.
export function TablePendingBoundary({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { isPending, isPendingVisible } = useTablePending();
  return (
    <div
      aria-busy={isPending}
      className={cn("relative", isPending && "cursor-wait", className)}
    >
      {isPendingVisible && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-t-lg">
          <div className="h-full w-1/3 animate-[table-pending-slide_1.1s_ease-in-out_infinite] bg-primary/60" />
        </div>
      )}
      <div
        className={cn(
          "transition-opacity duration-150",
          isPending && "pointer-events-none select-none",
          isPendingVisible && "opacity-60"
        )}
      >
        {children}
      </div>
    </div>
  );
}
