// Browser calls to the lab notebook link API. Each one throws a
// `NotebookLinkRequestError` when the server says no, so the caller can show
// the server's message, and spot a duplicate by its `linkId`.

import type {
  BulkAddNotebookLinkWire,
  BulkRemoveNotebookLinksWire,
  NotebookLinkWire,
} from "@/lib/api/run-notebook-link-wire";

export class NotebookLinkRequestError extends Error {
  readonly status: number;
  // Set on a 409 when the run already links to the same page.
  readonly linkId: string | null;

  constructor(status: number, message: string, linkId: string | null) {
    super(message);
    this.name = "NotebookLinkRequestError";
    this.status = status;
    this.linkId = linkId;
  }
}

interface RunRef {
  instrumentId: string;
  runId: string;
}

export function notebookLinksUrl({ instrumentId, runId }: RunRef): string {
  return `/api/v1/instruments/${encodeURIComponent(instrumentId)}/runs/${encodeURIComponent(runId)}/notebook-links`;
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
    error?: { message?: string; details?: { link_id?: unknown } };
  } | null;
  const linkId = body?.error?.details?.link_id;
  throw new NotebookLinkRequestError(
    res.status,
    body?.error?.message ?? "Request failed",
    typeof linkId === "string" ? linkId : null
  );
}

export function addNotebookLink(
  run: RunRef,
  link: { url: string; label: string }
): Promise<NotebookLinkWire> {
  return send(notebookLinksUrl(run), {
    method: "POST",
    body: JSON.stringify(link),
  });
}

export function updateNotebookLink(
  run: RunRef,
  linkId: string,
  link: { url: string; label: string }
): Promise<NotebookLinkWire> {
  return send(`${notebookLinksUrl(run)}/${encodeURIComponent(linkId)}`, {
    method: "PATCH",
    body: JSON.stringify(link),
  });
}

/** Resolves once the link is gone, including when it already was. */
export async function removeNotebookLink(
  run: RunRef,
  linkId: string
): Promise<void> {
  try {
    await send(`${notebookLinksUrl(run)}/${encodeURIComponent(linkId)}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (error instanceof NotebookLinkRequestError && error.status === 404) {
      return;
    }
    throw error;
  }
}

function wireRuns(runs: readonly RunRef[]) {
  return runs.map((run) => ({
    instrument_id: run.instrumentId,
    run_id: run.runId,
  }));
}

export function bulkAddNotebookLink(
  runs: readonly RunRef[],
  link: { url: string; label: string }
): Promise<BulkAddNotebookLinkWire> {
  return send("/api/v1/instrument-runs/notebook-links", {
    method: "POST",
    body: JSON.stringify({ runs: wireRuns(runs), ...link }),
  });
}

export function bulkRemoveNotebookLinks(
  runs: readonly RunRef[],
  urls: readonly string[]
): Promise<BulkRemoveNotebookLinksWire> {
  return send("/api/v1/instrument-runs/notebook-links/remove", {
    method: "POST",
    body: JSON.stringify({ runs: wireRuns(runs), urls }),
  });
}
