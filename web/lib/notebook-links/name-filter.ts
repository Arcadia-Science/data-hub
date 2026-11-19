// The "Lab Notebook" column filter matches runs by the names their links show
// in the runs table: a link's label, or the name worked out from its URL. The
// menu and the run list query both match through these helpers, so the runs a
// name finds are the runs the menu counted for it.

/** A link name in the filter menu, and how many runs have a link by that name. */
export interface NotebookLinkName {
  name: string;
  runCount: number;
}

export interface NotebookLinkNameOptions {
  // Most-used first, then by name.
  names: NotebookLinkName[];
  // For each run with links under two or more of the names, those names'
  // positions in `names`. The menu needs them to count the runs for "Labels
  // containing …" without counting such a run once per matching name.
  sharedRuns: number[][];
}

export const NO_NOTEBOOK_LINK_NAMES: NotebookLinkNameOptions = {
  names: [],
  sharedRuns: [],
};

/** Whether `name` contains `text`, ignoring case and surrounding spaces. */
export function notebookLinkNameContains(name: string, text: string): boolean {
  const needle = text.trim().toLowerCase();
  return needle !== "" && name.toLowerCase().includes(needle);
}

/** Whether a link name passes the filter's exact name or "contains" text. */
export function notebookLinkNameMatches(
  name: string,
  match: { name?: string; search?: string }
): boolean {
  if (match.name !== undefined && name !== match.name) {
    return false;
  }
  if (
    match.search !== undefined &&
    !notebookLinkNameContains(name, match.search)
  ) {
    return false;
  }
  return true;
}

/**
 * A run's links with the first one the filter matches moved to the front, so
 * a filtered table shows the link that put each run in the list.
 */
export function matchingLinkFirst<Link extends { display_name: string }>(
  links: Link[],
  match: { name?: string; search?: string }
): Link[] {
  if (match.name === undefined && match.search === undefined) {
    return links;
  }
  const index = links.findIndex((link) =>
    notebookLinkNameMatches(link.display_name, match)
  );
  if (index <= 0) {
    return links;
  }
  return [links[index], ...links.slice(0, index), ...links.slice(index + 1)];
}

/** Groups links by name and counts each run once per name. */
export function buildNotebookLinkNameOptions(
  links: ReadonlyArray<{ name: string; runId: string }>
): NotebookLinkNameOptions {
  const namesByRun = new Map<string, Set<string>>();
  for (const link of links) {
    const runNames = namesByRun.get(link.runId) ?? new Set<string>();
    runNames.add(link.name);
    namesByRun.set(link.runId, runNames);
  }

  const runCounts = new Map<string, number>();
  for (const runNames of namesByRun.values()) {
    for (const name of runNames) {
      runCounts.set(name, (runCounts.get(name) ?? 0) + 1);
    }
  }

  const names = [...runCounts]
    .map(([name, runCount]) => ({ name, runCount }))
    .sort((a, b) => b.runCount - a.runCount || a.name.localeCompare(b.name));
  const positions = new Map(names.map((entry, i) => [entry.name, i]));

  const sharedRuns: number[][] = [];
  for (const runNames of namesByRun.values()) {
    if (runNames.size > 1) {
      sharedRuns.push(
        [...runNames]
          .map((name) => positions.get(name) ?? -1)
          .sort((a, b) => a - b)
      );
    }
  }

  return { names, sharedRuns };
}

/** How many runs have at least one link whose name contains `text`. */
export function countRunsWithNameContaining(
  options: NotebookLinkNameOptions,
  text: string
): number {
  const matches = options.names.map((entry) =>
    notebookLinkNameContains(entry.name, text)
  );
  let total = 0;
  for (const [i, entry] of options.names.entries()) {
    if (matches[i]) {
      total += entry.runCount;
    }
  }
  // A run with several matching names was counted once for each of them.
  for (const runNames of options.sharedRuns) {
    const hits = runNames.filter((i) => matches[i]).length;
    if (hits > 1) {
      total -= hits - 1;
    }
  }
  return total;
}

/** What the "Lab Notebook" column is filtered to. */
export type NotebookLinkFilter =
  | { kind: "all" }
  | { kind: "has_link" }
  | { kind: "no_link" }
  | { kind: "name"; name: string }
  | { kind: "search"; text: string };

/** The URL params that hold a {@link NotebookLinkFilter}. */
export interface NotebookLinkFilterParams {
  has_notebook_link: "true" | "false" | null;
  notebook_link_name: string | null;
  notebook_link_search: string | null;
}

/**
 * Reads the column's filter from the URL. The menu sets one param at a time;
 * a hand-edited URL with several shows the most specific one as picked.
 */
export function readNotebookLinkFilter(
  params: NotebookLinkFilterParams
): NotebookLinkFilter {
  if (params.notebook_link_name !== null) {
    return { kind: "name", name: params.notebook_link_name };
  }
  if (params.notebook_link_search !== null) {
    return { kind: "search", text: params.notebook_link_search };
  }
  if (params.has_notebook_link === "true") {
    return { kind: "has_link" };
  }
  if (params.has_notebook_link === "false") {
    return { kind: "no_link" };
  }
  return { kind: "all" };
}

/** The URL params for a filter, clearing the ones it doesn't use. */
export function notebookLinkFilterParams(
  filter: NotebookLinkFilter
): NotebookLinkFilterParams {
  return {
    has_notebook_link:
      filter.kind === "has_link"
        ? "true"
        : filter.kind === "no_link"
          ? "false"
          : null,
    notebook_link_name: filter.kind === "name" ? filter.name : null,
    notebook_link_search: filter.kind === "search" ? filter.text : null,
  };
}
