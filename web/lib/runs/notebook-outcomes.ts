// What the run page and the bulk bar say after adding runs to a notebook or
// taking them out, worked out from the per-run outcomes the API returns.

import type { AddRunsWire } from "@/lib/api/notebook-wire";
import { NOTEBOOKS_PER_RUN_MAX } from "@/lib/notebook-links/url";

export function runsLabel(count: number): string {
  return `${count} ${count === 1 ? "run" : "runs"}`;
}

function isAre(count: number): string {
  return count === 1 ? "is" : "are";
}

function wasWere(count: number): string {
  return count === 1 ? "was" : "were";
}

/**
 * The toast after adding several runs to a notebook. It's a warning when
 * some runs couldn't be added.
 */
export function addRunsSummary(
  notebookName: string,
  counts: AddRunsWire["counts"]
): { message: string; tone: "success" | "warning" } {
  const parts = [`Added ${runsLabel(counts.added)} to “${notebookName}”.`];
  if (counts.already_in_notebook > 0) {
    parts.push(
      `${runsLabel(counts.already_in_notebook)} ${wasWere(counts.already_in_notebook)} already in it.`
    );
  }
  if (counts.limit_reached > 0) {
    parts.push(
      `${runsLabel(counts.limit_reached)} ${isAre(counts.limit_reached)} already in ${NOTEBOOKS_PER_RUN_MAX} notebooks, the most allowed.`
    );
  }
  const unchanged = counts.not_found + counts.run_deleted;
  if (unchanged > 0) {
    parts.push(`${runsLabel(unchanged)} couldn't be changed.`);
  }
  return {
    message: parts.join(" "),
    tone: counts.limit_reached + unchanged > 0 ? "warning" : "success",
  };
}

/**
 * Why one run couldn't go into a notebook, or null when it's in it now,
 * including when it already was.
 */
export function addRunError(
  outcome: AddRunsWire["results"][number]["outcome"] | undefined
): string | null {
  switch (outcome) {
    case "added":
    case "already_in_notebook":
      return null;
    case "limit_reached":
      return `This run is already in ${NOTEBOOKS_PER_RUN_MAX} notebooks, the most allowed.`;
    case "run_deleted":
      return "This run is deleted, so its notebooks can't change.";
    default:
      return "Couldn't find this run.";
  }
}

export interface RunWithNotebooks {
  notebooks: ReadonlyArray<{ id: string; name: string; url: string }>;
}

/** A notebook some of the selected runs are in, and how many of them. */
export interface SelectedRunsNotebook {
  id: string;
  name: string;
  runCount: number;
  url: string;
}

/** The notebooks the runs are in, the most shared first, then by name. */
export function notebooksOfRuns(
  runs: readonly RunWithNotebooks[]
): SelectedRunsNotebook[] {
  const byId = new Map<string, SelectedRunsNotebook>();
  for (const run of runs) {
    for (const notebook of run.notebooks) {
      const entry = byId.get(notebook.id);
      if (entry) {
        entry.runCount += 1;
      } else {
        byId.set(notebook.id, {
          id: notebook.id,
          name: notebook.name,
          url: notebook.url,
          runCount: 1,
        });
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.runCount - a.runCount || a.name.localeCompare(b.name)
  );
}

/**
 * The toast after taking the selected runs out of some notebooks, one
 * request per notebook. `removedRuns` counts each run once, however many of
 * the notebooks it left.
 */
export function removeRunsSummary(input: {
  failedNotebooks: number;
  notebookNames: readonly string[];
  removedRuns: number;
}): { message: string; tone: "success" | "warning" | "error" } {
  const { failedNotebooks, notebookNames, removedRuns } = input;
  const total = notebookNames.length;
  const target = total === 1 ? `“${notebookNames[0]}”` : `${total} notebooks`;
  if (failedNotebooks >= total) {
    return {
      message: `Couldn't remove runs from ${target}. Try again?`,
      tone: "error",
    };
  }
  if (failedNotebooks > 0) {
    return {
      message: `Removed ${runsLabel(removedRuns)}, but ${failedNotebooks} of the ${total} notebooks couldn't be changed. Try again?`,
      tone: "warning",
    };
  }
  return {
    message: `Removed ${runsLabel(removedRuns)} from ${target}.`,
    tone: "success",
  };
}
