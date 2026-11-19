"use client";

import { useCallback, useEffect, useState } from "react";
import {
  parseRecentNotebooks,
  RECENT_NOTEBOOKS_STORAGE_KEY,
  type RecentNotebook,
  serializeRecentNotebooks,
  withNotebookVisit,
  withoutNotebook,
} from "@/lib/notebooks/recent";

export type { RecentNotebook } from "@/lib/notebooks/recent";

const UPDATE_EVENT = "data-hub:recent-notebooks-updated";

function readRecentNotebooks(): RecentNotebook[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    return parseRecentNotebooks(
      localStorage.getItem(RECENT_NOTEBOOKS_STORAGE_KEY)
    );
  } catch {
    return [];
  }
}

function writeRecentNotebooks(list: RecentNotebook[]): void {
  try {
    localStorage.setItem(
      RECENT_NOTEBOOKS_STORAGE_KEY,
      serializeRecentNotebooks(list)
    );
    // Deferred, so other hook instances (the sidebar) refresh after this
    // setState commits, not inside the updater.
    queueMicrotask(() => {
      window.dispatchEvent(new Event(UPDATE_EVENT));
    });
  } catch {
    // Private browsing or a full quota. The list just doesn't persist.
  }
}

/**
 * The notebooks this browser opened most recently, newest first, kept in
 * step across tabs and across every component that uses the hook.
 */
export function useRecentNotebooks() {
  const [recent, setRecent] = useState<RecentNotebook[]>([]);

  useEffect(() => {
    setRecent(readRecentNotebooks());

    function refresh() {
      setRecent(readRecentNotebooks());
    }
    function onStorage(event: StorageEvent) {
      if (event.key === RECENT_NOTEBOOKS_STORAGE_KEY) {
        refresh();
      }
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener(UPDATE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(UPDATE_EVENT, refresh);
    };
  }, []);

  const recordVisit = useCallback((visit: RecentNotebook) => {
    // Read storage, not state: on the page that records the visit, the
    // effect above may not have loaded the list yet.
    const next = withNotebookVisit(readRecentNotebooks(), visit);
    writeRecentNotebooks(next);
    setRecent(next);
  }, []);

  const forget = useCallback((notebookId: string) => {
    const current = readRecentNotebooks();
    const next = withoutNotebook(current, notebookId);
    if (next.length !== current.length) {
      writeRecentNotebooks(next);
    }
    setRecent(next);
  }, []);

  return { recent, recordVisit, forget };
}
