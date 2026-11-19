// The rules behind the notebook picker on run pages and in the bulk bar. Its
// one box takes a name to search for or a pasted link, and what was typed
// decides whether the runs go into an existing notebook, a deleted one that
// is restored first, or a new one for the page.

import { parseNotebookLinkUrl } from "@/lib/notebook-links/url";

/** What the picker's box holds: a link to a page, or text to search for. */
export type NotebookQuery =
  | { kind: "link"; url: string }
  | { kind: "name"; text: string };

/**
 * Reads the box. Only a full http or https link counts as a link, so a name
 * that happens to contain a dot is still searched for by name.
 */
export function readNotebookQuery(input: string): NotebookQuery {
  const text = input.trim();
  const parsed = text.includes("://") ? parseNotebookLinkUrl(text) : null;
  return parsed ? { kind: "link", url: parsed.url } : { kind: "name", text };
}

interface LookupNotebook {
  deleted_at: string | null;
  id: string;
}

/** Where a lookup for the current query stands. */
export type NotebookLookup<Notebook extends LookupNotebook> =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "done"; notebooks: Notebook[] };

/** What the picker would do if the form were sent now. */
export type NotebookPickerState<Notebook extends LookupNotebook> =
  // Searching by name, and nothing is picked yet.
  | { kind: "searching" }
  // A pasted link is being looked up.
  | { kind: "looking_up" }
  // The lookup for a pasted link failed.
  | { kind: "lookup_failed" }
  // Add the runs to this notebook.
  | { kind: "existing"; notebook: Notebook }
  // This deleted notebook has the page: restore it, then add the runs.
  | { kind: "restore"; notebook: Notebook }
  // No notebook has the page: create one for it.
  | { kind: "create"; url: string };

/**
 * Works out the picker's state. A pasted link picks the notebook that has the
 * page, deleted or not, or offers to create one. A name search waits for
 * the person to pick a notebook from the list.
 */
export function notebookPickerState<Notebook extends LookupNotebook>(input: {
  lookup: NotebookLookup<Notebook>;
  picked: Notebook | null;
  query: NotebookQuery;
}): NotebookPickerState<Notebook> {
  const { lookup, picked, query } = input;
  if (query.kind === "name") {
    return picked
      ? { kind: "existing", notebook: picked }
      : { kind: "searching" };
  }
  if (lookup.status === "loading") {
    return { kind: "looking_up" };
  }
  if (lookup.status === "failed") {
    return { kind: "lookup_failed" };
  }
  // The lookup matches the page exactly, so it finds one notebook at most.
  const [notebook] = lookup.notebooks;
  if (!notebook) {
    return { kind: "create", url: query.url };
  }
  return notebook.deleted_at === null
    ? { kind: "existing", notebook }
    : { kind: "restore", notebook };
}

/** How many of the runs being added are already in the notebook. */
export function runsAlreadyIn(
  runNotebookIds: ReadonlyArray<readonly string[]>,
  notebookId: string
): number {
  return runNotebookIds.filter((ids) => ids.includes(notebookId)).length;
}
