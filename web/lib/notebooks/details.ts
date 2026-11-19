// Wording, checks, and request bodies for a lab notebook's own page and its
// dialogs. No server imports, so pages and client components share it.

import {
  notebookDescriptionSchema,
  notebookLinkUrlSchema,
  notebookNameFromUrl,
  notebookNameSchema,
  notebookUrlKey,
} from "@/lib/notebook-links/url";

/** The Data Hub page for a notebook. */
export function notebookPageHref(notebookId: string): string {
  return `/lab-notebooks/${encodeURIComponent(notebookId)}`;
}

/** "1 run", "2 runs". */
export function countLabel(count: number, one: string, many?: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : (many ?? `${one}s`)}`;
}

/** What the Delete confirmation says about the notebook's runs. */
export function deleteNotebookMessage(name: string, runCount: number): string {
  if (runCount === 0) {
    return `“${name}” has no runs. You can restore it later.`;
  }
  return `This takes ${countLabel(runCount, "run")} out of “${name}”. Restoring the lab notebook puts ${runCount === 1 ? "it" : "them"} back.`;
}

/**
 * Who owns the notebook after an edit: the viewer, the person who owns it
 * now (when that is someone else), or nobody.
 */
export type OwnerChoice = "me" | "current" | "none";

export function initialOwnerChoice(
  ownerId: string | null,
  viewerId: string
): OwnerChoice {
  if (ownerId === null) {
    return "none";
  }
  return ownerId === viewerId ? "me" : "current";
}

export interface NotebookEditValues {
  description: string;
  name: string;
  owner: OwnerChoice;
  url: string;
}

/** The fields `PATCH /api/v1/lab-notebooks/:id` takes. */
export interface NotebookPatch {
  description?: string | null;
  name?: string;
  owner_id?: string | null;
  url?: string;
}

/**
 * The PATCH body for an edit: only the fields that changed, so saving an
 * unchanged form sends nothing. Values are compared after trimming, and a
 * blank description clears it.
 */
export function notebookEditPatch(
  initial: {
    description: string | null;
    name: string;
    owner: OwnerChoice;
    url: string;
  },
  values: NotebookEditValues
): NotebookPatch {
  const patch: NotebookPatch = {};
  const name = values.name.trim();
  if (name !== initial.name) {
    patch.name = name;
  }
  const url = values.url.trim();
  if (url !== initial.url) {
    patch.url = url;
  }
  const description = values.description.trim() || null;
  if (description !== (initial.description ?? null)) {
    patch.description = description;
  }
  if (values.owner !== initial.owner) {
    if (values.owner === "me") {
      patch.owner_id = "me";
    } else if (values.owner === "none") {
      patch.owner_id = null;
    }
  }
  return patch;
}

/** What `/lab-notebooks` says when the list is empty, for the search it ran. */
export function notebooksEmptyMessage(query: string): string {
  const trimmed = query.trim();
  if (trimmed === "") {
    return "No lab notebooks yet. Create one with New lab notebook, or add a run to a lab notebook from the run’s page.";
  }
  if (trimmed.includes("://") && notebookUrlKey(trimmed) !== null) {
    return "No lab notebook has this page yet. Create one with New lab notebook.";
  }
  return "No lab notebooks match your search.";
}

/**
 * The name a new notebook form suggests for a link: the page name taken from
 * the link, or nothing until the link is one Data Hub accepts.
 */
export function suggestedNotebookName(url: string): string {
  const trimmed = url.trim();
  return notebookUrlKey(trimmed) === null ? "" : notebookNameFromUrl(trimmed);
}

/** What's wrong with each field of a notebook form, by field. */
export interface NotebookFieldErrors {
  description?: string;
  name?: string;
  url?: string;
}

/**
 * Checks a notebook form with the same rules the API applies, so most
 * mistakes show up beside their field before anything is sent.
 */
export function notebookFieldErrors(values: {
  description: string;
  name: string;
  url: string;
}): NotebookFieldErrors {
  const errors: NotebookFieldErrors = {};
  const url = notebookLinkUrlSchema.safeParse(values.url);
  if (!url.success) {
    errors.url = url.error.issues[0]?.message ?? "Enter a link.";
  }
  const name = notebookNameSchema.safeParse(values.name);
  if (!name.success) {
    errors.name = name.error.issues[0]?.message ?? "Enter a name.";
  }
  const description = notebookDescriptionSchema.safeParse(values.description);
  if (!description.success) {
    errors.description =
      description.error.issues[0]?.message ?? "Shorten the description.";
  }
  return errors;
}
