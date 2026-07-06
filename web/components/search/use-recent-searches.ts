"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "data-hub:recent-searches";
const MAX_RECENT = 8;

function read(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    // Corrupt or unavailable storage — treat as no history.
    return [];
  }
}

/**
 * Session-persisted recent search queries backed by `localStorage`. Kept
 * client-only and per-browser by design (v1 has no server-side history).
 * Returns the list plus `add`/`clear` mutators; the list is capped at
 * MAX_RECENT with most-recent-first ordering and case-insensitive dedup.
 */
export function useRecentSearches() {
  const [recent, setRecent] = useState<string[]>([]);

  // Hydrate after mount to avoid a server/client mismatch on the SSR'd shell.
  useEffect(() => {
    setRecent(read());
  }, []);

  const persist = useCallback((next: string[]) => {
    setRecent(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked — the in-memory list still works this session.
    }
  }, []);

  const add = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) {
        return;
      }
      setRecent((current) => {
        const deduped = current.filter(
          (q) => q.toLowerCase() !== trimmed.toLowerCase()
        );
        const next = [trimmed, ...deduped].slice(0, MAX_RECENT);
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore — see persist()
        }
        return next;
      });
    },
    // persist intentionally unused here; add() writes inline to avoid a stale
    // closure over `recent`.
    []
  );

  const clear = useCallback(() => {
    persist([]);
  }, [persist]);

  return { recent, add, clear };
}
