"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "data-hub:changelog-seen";
const UPDATE_EVENT = "data-hub:changelog-seen-updated";

// Ids, not a last-visited timestamp. An entry's date is the day it merged
// to staging, which can be earlier than the last time this person opened
// the changelog, so a timestamp would hide an entry they have not seen.
export function hasUnseen(
  ids: readonly string[],
  seen: readonly string[]
): boolean {
  return listUnseen(ids, seen).length > 0;
}

export function listUnseen(
  ids: readonly string[],
  seen: readonly string[]
): string[] {
  if (ids.length === 0) {
    return [];
  }
  const seenSet = new Set(seen);
  return ids.filter((id) => !seenSet.has(id));
}

export function useChangelogSeen() {
  const [seen, setSeen] = useState<string[] | null>(null);

  useEffect(() => {
    setSeen(readChangelogSeenIds());
  }, []);

  useEffect(() => {
    function refresh() {
      setSeen(readChangelogSeenIds());
    }

    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) {
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

  const markSeen = useCallback((ids: readonly string[]) => {
    setSeen((current) => {
      const base = current ?? readChangelogSeenIds();
      const next = unionSorted(base, ids);
      if (sameIds(base, next)) {
        return base;
      }
      writeSeenIds(next);
      return next;
    });
  }, []);

  return {
    hasUnseen(ids: readonly string[]) {
      return seen !== null && hasUnseen(ids, seen);
    },
    markSeen,
  };
}

export function readChangelogSeenIds(): string[] {
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
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function writeSeenIds(ids: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    queueMicrotask(() => {
      window.dispatchEvent(new Event(UPDATE_EVENT));
    });
  } catch {
    // Private browsing or a full disk. The dot stays until a later visit.
  }
}

function unionSorted(current: readonly string[], incoming: readonly string[]) {
  return [...new Set([...current, ...incoming])].sort();
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  return b.every((id) => set.has(id));
}
