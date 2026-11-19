// The notebooks the viewer opened most recently, newest first, which the
// sidebar lists before the notebooks that most recently got a run. The list
// lives in the browser's localStorage, so these helpers are pure: the
// `useRecentNotebooks` hook reads and writes the storage itself.

import { parseVersioned, serializeVersioned } from "@/lib/versioned-storage";

export interface RecentNotebook {
  // The name when the notebook was last opened. A rename shows up on the
  // next visit.
  name: string;
  notebookId: string;
  visitedAt: number;
}

export const RECENT_NOTEBOOKS_STORAGE_KEY = "data-hub:recent-notebooks";

// How many visits the browser keeps. The sidebar shows only the first few.
export const RECENT_NOTEBOOKS_MAX = 50;

function isRecentNotebook(entry: unknown): entry is RecentNotebook {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry as Partial<RecentNotebook>;
  return (
    typeof candidate.notebookId === "string" &&
    candidate.notebookId !== "" &&
    typeof candidate.name === "string" &&
    typeof candidate.visitedAt === "number"
  );
}

/**
 * Reads the saved list. Anything unusable reads as an empty list, and entries
 * that don't have the expected fields are skipped.
 */
export function parseRecentNotebooks(raw: string | null): RecentNotebook[] {
  const parsed = parseVersioned(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return dedupeAndCap(parsed.filter(isRecentNotebook));
}

export function serializeRecentNotebooks(list: RecentNotebook[]): string {
  return serializeVersioned(list);
}

function dedupeAndCap(list: RecentNotebook[]): RecentNotebook[] {
  const seen = new Set<string>();
  const next: RecentNotebook[] = [];
  for (const entry of list) {
    if (seen.has(entry.notebookId)) {
      continue;
    }
    seen.add(entry.notebookId);
    next.push(entry);
    if (next.length >= RECENT_NOTEBOOKS_MAX) {
      break;
    }
  }
  return next;
}

/** The list with this visit first and any earlier visit to it dropped. */
export function withNotebookVisit(
  list: RecentNotebook[],
  visit: RecentNotebook
): RecentNotebook[] {
  return dedupeAndCap([
    visit,
    ...list.filter((entry) => entry.notebookId !== visit.notebookId),
  ]);
}

/** The list without a notebook, for one that was deleted. */
export function withoutNotebook(
  list: RecentNotebook[],
  notebookId: string
): RecentNotebook[] {
  return list.filter((entry) => entry.notebookId !== notebookId);
}
