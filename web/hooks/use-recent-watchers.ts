"use client";

import { useCallback, useEffect, useState } from "react";

export interface RecentWatcher {
  label: string;
  visitedAt: number;
  watcherId: string;
}

const STORAGE_KEY = "data-hub:recent-watchers";
const UPDATE_EVENT = "data-hub:recent-watchers-updated";
const MAX_RECENT = 50;

function watcherFallbackLabel(watcherId: string): string {
  return `${watcherId.slice(0, 8)}…`;
}

function readRecentWatchers(): RecentWatcher[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is RecentWatcher =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RecentWatcher).watcherId === "string" &&
        typeof (entry as RecentWatcher).label === "string" &&
        typeof (entry as RecentWatcher).visitedAt === "number"
    );
  } catch {
    return [];
  }
}

function writeRecentWatchers(watchers: RecentWatcher[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(watchers));
    window.dispatchEvent(new Event(UPDATE_EVENT));
  } catch {
    // Private browsing or quota exceeded — ignore.
  }
}

function dedupeAndCap(watchers: RecentWatcher[]): RecentWatcher[] {
  const seen = new Set<string>();
  const next: RecentWatcher[] = [];

  for (const watcher of watchers) {
    if (seen.has(watcher.watcherId)) {
      continue;
    }
    seen.add(watcher.watcherId);
    next.push(watcher);
    if (next.length >= MAX_RECENT) {
      break;
    }
  }

  return next;
}

function resolveLabel(
  watcherId: string,
  label: string,
  existing: RecentWatcher | undefined
): string {
  if (label !== watcherFallbackLabel(watcherId)) {
    return label;
  }
  return existing?.label ?? label;
}

export function useRecentWatchers() {
  const [recent, setRecent] = useState<RecentWatcher[]>([]);

  useEffect(() => {
    setRecent(readRecentWatchers());
  }, []);

  useEffect(() => {
    function refreshRecent() {
      setRecent(readRecentWatchers());
    }

    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) {
        refreshRecent();
      }
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener(UPDATE_EVENT, refreshRecent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(UPDATE_EVENT, refreshRecent);
    };
  }, []);

  const recordVisit = useCallback((watcher: RecentWatcher) => {
    setRecent((current) => {
      const existing = current.find(
        (entry) => entry.watcherId === watcher.watcherId
      );
      const entry: RecentWatcher = {
        watcherId: watcher.watcherId,
        label: resolveLabel(watcher.watcherId, watcher.label, existing),
        visitedAt: watcher.visitedAt,
      };
      const filtered = current.filter(
        (item) => item.watcherId !== watcher.watcherId
      );
      const next = dedupeAndCap([entry, ...filtered]);
      writeRecentWatchers(next);
      return next;
    });
  }, []);

  return { recent, recordVisit };
}

export function watcherNavLabel(
  watcherId: string,
  hostname: string | null
): string {
  return hostname ?? watcherFallbackLabel(watcherId);
}
