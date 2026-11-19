// The "Lab Notebook" column filter in the runs tables: every run, runs in any
// notebook, runs in none, or runs in one notebook picked by ID. The URL holds
// it in `has_notebook` and `notebook_id` (see `notebookFilterSearchParams`).
// The menu lists the notebooks from `getNotebookFilterOptions`.

/** What the "Lab Notebook" column is filtered to. */
export type NotebookFilter =
  | { kind: "all" }
  | { kind: "has_notebook" }
  | { kind: "no_notebook" }
  | { kind: "notebook"; id: string };

/** The URL params that hold a {@link NotebookFilter}. */
export interface NotebookFilterParams {
  has_notebook: "true" | "false" | null;
  notebook_id: string | null;
}

/**
 * Reads the column's filter from the URL. The menu sets one param at a time;
 * a hand-edited URL with both shows the notebook as picked.
 */
export function readNotebookFilter(
  params: NotebookFilterParams
): NotebookFilter {
  const id = params.notebook_id?.trim();
  if (id) {
    return { kind: "notebook", id };
  }
  if (params.has_notebook === "true") {
    return { kind: "has_notebook" };
  }
  if (params.has_notebook === "false") {
    return { kind: "no_notebook" };
  }
  return { kind: "all" };
}

/** The URL params for a filter, clearing the one it doesn't use. */
export function notebookFilterParams(
  filter: NotebookFilter
): NotebookFilterParams {
  let hasNotebook: NotebookFilterParams["has_notebook"] = null;
  if (filter.kind === "has_notebook") {
    hasNotebook = "true";
  } else if (filter.kind === "no_notebook") {
    hasNotebook = "false";
  }
  return {
    has_notebook: hasNotebook,
    notebook_id: filter.kind === "notebook" ? filter.id : null,
  };
}

/**
 * The menu's notebooks whose name contains `text`, ignoring case and
 * surrounding spaces. Blank text keeps them all.
 */
export function narrowNotebookOptions<Option extends { name: string }>(
  options: readonly Option[],
  text: string
): Option[] {
  const needle = text.trim().toLowerCase();
  if (needle === "") {
    return [...options];
  }
  return options.filter((option) => option.name.toLowerCase().includes(needle));
}

/**
 * A run's notebooks with the one the column is filtered to moved to the
 * front, so a filtered table shows the notebook that put each run in the list.
 */
export function matchingNotebookFirst<Notebook extends { id: string }>(
  notebooks: readonly Notebook[],
  notebookId: string | null
): Notebook[] {
  const index = notebookId
    ? notebooks.findIndex((notebook) => notebook.id === notebookId)
    : -1;
  if (index <= 0) {
    return [...notebooks];
  }
  return [
    notebooks[index],
    ...notebooks.slice(0, index),
    ...notebooks.slice(index + 1),
  ];
}
