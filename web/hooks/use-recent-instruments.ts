"use client";

import { useCallback, useEffect, useState } from "react";

export interface RecentInstrument {
  displayName: string;
  instrumentId: string;
  visitedAt: number;
}

const STORAGE_KEY = "data-hub:recent-instruments";
const UPDATE_EVENT = "data-hub:recent-instruments-updated";
const MAX_RECENT = 50;

function readRecentInstruments(): RecentInstrument[] {
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
      (entry): entry is RecentInstrument =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RecentInstrument).instrumentId === "string" &&
        typeof (entry as RecentInstrument).displayName === "string" &&
        typeof (entry as RecentInstrument).visitedAt === "number"
    );
  } catch {
    return [];
  }
}

function writeRecentInstruments(instruments: RecentInstrument[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(instruments));
    window.dispatchEvent(new Event(UPDATE_EVENT));
  } catch {
    // Private browsing or quota exceeded — ignore.
  }
}

function dedupeAndCap(instruments: RecentInstrument[]): RecentInstrument[] {
  const seen = new Set<string>();
  const next: RecentInstrument[] = [];

  for (const instrument of instruments) {
    if (seen.has(instrument.instrumentId)) {
      continue;
    }
    seen.add(instrument.instrumentId);
    next.push(instrument);
    if (next.length >= MAX_RECENT) {
      break;
    }
  }

  return next;
}

function resolveDisplayName(
  instrumentId: string,
  displayName: string,
  existing: RecentInstrument | undefined
): string {
  if (displayName !== instrumentId) {
    return displayName;
  }
  return existing?.displayName ?? displayName;
}

export function useRecentInstruments() {
  const [recent, setRecent] = useState<RecentInstrument[]>([]);

  useEffect(() => {
    setRecent(readRecentInstruments());
  }, []);

  useEffect(() => {
    function refreshRecent() {
      setRecent(readRecentInstruments());
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

  const recordVisit = useCallback((instrument: RecentInstrument) => {
    setRecent((current) => {
      const existing = current.find(
        (entry) => entry.instrumentId === instrument.instrumentId
      );
      const entry: RecentInstrument = {
        instrumentId: instrument.instrumentId,
        displayName: resolveDisplayName(
          instrument.instrumentId,
          instrument.displayName,
          existing
        ),
        visitedAt: instrument.visitedAt,
      };
      const filtered = current.filter(
        (item) => item.instrumentId !== instrument.instrumentId
      );
      const next = dedupeAndCap([entry, ...filtered]);
      writeRecentInstruments(next);
      return next;
    });
  }, []);

  return { recent, recordVisit };
}
