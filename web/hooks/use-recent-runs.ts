"use client";

import { useCallback, useEffect, useState } from "react";

export interface RecentRun {
  instrumentDisplayName: string;
  instrumentId: string;
  runId: string;
  visitedAt: number;
}

const STORAGE_KEY = "data-hub:recent-runs";
const MAX_RECENT = 50;

function readRecentRuns(): RecentRun[] {
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
      (entry): entry is RecentRun =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RecentRun).instrumentId === "string" &&
        typeof (entry as RecentRun).runId === "string" &&
        typeof (entry as RecentRun).instrumentDisplayName === "string" &&
        typeof (entry as RecentRun).visitedAt === "number"
    );
  } catch {
    return [];
  }
}

function writeRecentRuns(runs: RecentRun[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
  } catch {
    // Private browsing or quota exceeded — ignore.
  }
}

function dedupeAndCap(runs: RecentRun[]): RecentRun[] {
  const seen = new Set<string>();
  const next: RecentRun[] = [];

  for (const run of runs) {
    const key = `${run.instrumentId}:${run.runId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(run);
    if (next.length >= MAX_RECENT) {
      break;
    }
  }

  return next;
}

export function useRecentRuns() {
  const [recent, setRecent] = useState<RecentRun[]>([]);

  useEffect(() => {
    setRecent(readRecentRuns());
  }, []);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) {
        setRecent(readRecentRuns());
      }
    }

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const recordVisit = useCallback((run: RecentRun) => {
    setRecent((current) => {
      const key = `${run.instrumentId}:${run.runId}`;
      const filtered = current.filter(
        (entry) => `${entry.instrumentId}:${entry.runId}` !== key
      );
      const next = dedupeAndCap([run, ...filtered]);
      writeRecentRuns(next);
      return next;
    });
  }, []);

  return { recent, recordVisit };
}
