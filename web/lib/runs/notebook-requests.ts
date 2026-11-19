// Browser calls to the lab notebook API. Each one throws a
// `NotebookRequestError` when the server says no, so the caller can show the
// server's message, and spot a page that already has a notebook by its
// `notebookId`.

import { apiErrorMessage } from "@/lib/api/errors";
import type {
  AddRunsWire,
  NotebookWire,
  RemoveRunsWire,
} from "@/lib/api/notebook-wire";

export class NotebookRequestError extends Error {
  readonly status: number;
  // Set on a 409 when another notebook already has the page.
  readonly notebookId: string | null;
  // Whether that notebook is deleted.
  readonly notebookDeleted: boolean;

  constructor(
    status: number,
    message: string,
    conflict: { notebookId: string | null; deleted: boolean } = {
      notebookId: null,
      deleted: false,
    }
  ) {
    super(message);
    this.name = "NotebookRequestError";
    this.status = status;
    this.notebookId = conflict.notebookId;
    this.notebookDeleted = conflict.deleted;
  }
}

export interface RunRef {
  instrumentId: string;
  runId: string;
}

const NOTEBOOKS_URL = "/api/v1/lab-notebooks";

function notebookUrl(notebookId: string): string {
  return `${NOTEBOOKS_URL}/${encodeURIComponent(notebookId)}`;
}

async function send<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  if (res.ok) {
    return (await res.json()) as T;
  }
  const body = (await res.json().catch(() => null)) as {
    error?: { details?: { lab_notebook_id?: unknown; deleted?: unknown } };
  } | null;
  const details = body?.error?.details;
  throw new NotebookRequestError(
    res.status,
    apiErrorMessage(body, "Request failed"),
    {
      notebookId:
        typeof details?.lab_notebook_id === "string"
          ? details.lab_notebook_id
          : null,
      deleted: details?.deleted === true,
    }
  );
}

function wireRuns(runs: readonly RunRef[]) {
  return runs.map((run) => ({
    instrument_id: run.instrumentId,
    run_id: run.runId,
  }));
}

/**
 * Notebooks whose name or description contains `query`, or, for a pasted
 * link, the notebook for that page. A blank query lists the notebooks with
 * the newest runs first.
 */
export async function searchNotebooks(
  query: string,
  options: { includeDeleted?: boolean; perPage: number; signal?: AbortSignal }
): Promise<NotebookWire[]> {
  const params = new URLSearchParams({ per_page: String(options.perPage) });
  const q = query.trim();
  if (q) {
    params.set("q", q);
  }
  if (options.includeDeleted) {
    params.set("include_deleted", "true");
  }
  const res = await fetch(`${NOTEBOOKS_URL}?${params}`, {
    signal: options.signal,
  });
  if (!res.ok) {
    throw new NotebookRequestError(
      res.status,
      apiErrorMessage(await res.json().catch(() => null), "Request failed")
    );
  }
  const body = (await res.json()) as { data: NotebookWire[] };
  return body.data;
}

/**
 * Creates a notebook for a page and adds the runs to it in one request.
 * `ownedByMe` makes the signed-in person its owner.
 */
export function createNotebook(input: {
  name: string;
  ownedByMe: boolean;
  runs: readonly RunRef[];
  url: string;
}): Promise<{ lab_notebook: NotebookWire; runs: AddRunsWire | null }> {
  return send(NOTEBOOKS_URL, {
    method: "POST",
    body: JSON.stringify({
      url: input.url,
      name: input.name,
      ...(input.ownedByMe && { owner_id: "me" }),
      runs: wireRuns(input.runs),
    }),
  });
}

export function addRunsToNotebook(
  notebookId: string,
  runs: readonly RunRef[]
): Promise<AddRunsWire> {
  return send(`${notebookUrl(notebookId)}/runs`, {
    method: "POST",
    body: JSON.stringify({ runs: wireRuns(runs) }),
  });
}

export function removeRunsFromNotebook(
  notebookId: string,
  runs: readonly RunRef[]
): Promise<RemoveRunsWire> {
  return send(`${notebookUrl(notebookId)}/runs/remove`, {
    method: "POST",
    body: JSON.stringify({ runs: wireRuns(runs) }),
  });
}

export function restoreNotebook(notebookId: string): Promise<NotebookWire> {
  return send(`${notebookUrl(notebookId)}/restore`, { method: "POST" });
}

/** The notebook the picker settled on, and what adding runs to it takes. */
export type NotebookPick =
  // A notebook that exists: add the runs to it.
  | { kind: "existing"; notebook: PickedNotebook }
  // A deleted notebook: restore it, then add the runs.
  | { kind: "restore"; notebook: PickedNotebook }
  // A page no notebook has yet: create one with this name and the runs.
  | { kind: "create"; name: string; ownedByMe: boolean; url: string };

export interface PickedNotebook {
  id: string;
  name: string;
  url: string;
}

/**
 * Adds the runs to the picked notebook, first creating or restoring it when
 * the pick says to. Resolves with the notebook and each run's outcome.
 */
export async function addRunsToPick(
  pick: NotebookPick,
  runs: readonly RunRef[]
): Promise<{ notebook: PickedNotebook; result: AddRunsWire }> {
  if (pick.kind === "create") {
    const created = await createNotebook({
      url: pick.url,
      name: pick.name,
      ownedByMe: pick.ownedByMe,
      runs,
    });
    const notebook = {
      id: created.lab_notebook.id,
      name: created.lab_notebook.name,
      url: created.lab_notebook.url,
    };
    return {
      notebook,
      result: created.runs ?? {
        lab_notebook_id: notebook.id,
        results: [],
        counts: {
          added: 0,
          already_in_lab_notebook: 0,
          run_deleted: 0,
          limit_reached: 0,
          not_found: 0,
        },
      },
    };
  }
  if (pick.kind === "restore") {
    try {
      await restoreNotebook(pick.notebook.id);
    } catch (error) {
      // 409 means someone restored it first, so the runs can still go in.
      if (!(error instanceof NotebookRequestError && error.status === 409)) {
        throw error;
      }
    }
  }
  const result = await addRunsToNotebook(pick.notebook.id, runs);
  return { notebook: pick.notebook, result };
}
