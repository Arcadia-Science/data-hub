import { apiErrorMessage } from "@/lib/api/errors";
import { FILE_ACTION_IDS_MAX } from "@/lib/runs/file-action-limits";
import {
  folderOfPath,
  type LinkedFileRelation,
  pathOf,
} from "@/lib/runs/file-links";

// Client-side calls that delete files of a run, restore them, and ask what
// would go along. They use the batch endpoints, which take at most
// `FILE_ACTION_IDS_MAX` files a request, so each call takes its files already
// cut into batches: `fileBatches` for files the person selected, and
// `inBatches` for a plain list of IDs. Client-safe: plain `fetch`, no server
// imports.

function runFilesUrl(instrumentId: string, runId: string, path: string) {
  return `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/files/${path}`;
}

/** The list cut into the batches one request takes, in order. */
export function inBatches<T>(
  items: readonly T[],
  size: number = FILE_ACTION_IDS_MAX
): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/**
 * The IDs of `files` cut into batches of at most `size`, with the files of one
 * folder kept in the same batch. The server takes a folder's sidecar run.json
 * along only when every raw file of that folder is in the request, so a folder
 * split across two batches would keep its sidecar. Folders go in the order of
 * their first file.
 *
 * A folder with more selected files than one batch holds still has to be
 * split, and then its sidecar stays behind.
 */
export function fileBatches(
  files: readonly {
    filename: string;
    id: number;
    relativePath: string | null;
  }[],
  size: number = FILE_ACTION_IDS_MAX
): number[][] {
  const byFolder = new Map<string, number[]>();
  for (const file of files) {
    const folder = folderOfPath(pathOf(file));
    const ids = byFolder.get(folder);
    if (ids) {
      ids.push(file.id);
    } else {
      byFolder.set(folder, [file.id]);
    }
  }
  const batches: number[][] = [];
  let current: number[] = [];
  for (const ids of byFolder.values()) {
    if (current.length + ids.length > size && current.length > 0) {
      batches.push(current);
      current = [];
    }
    if (ids.length > size) {
      batches.push(...inBatches(ids, size));
      continue;
    }
    current.push(...ids);
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

// ---------------------------------------------------------------------------
// What a response says
// ---------------------------------------------------------------------------

export interface FileActionTally {
  // Files that are now in the state the action asked for, including ones that
  // were in it already.
  done: number;
  // Files the action could not change.
  failed: number;
  // The first reason the server gave for a failure, so a refusal can say why.
  message: string | null;
}

export interface DeleteTally extends FileActionTally {
  // The files this call deleted: the requested files that were not deleted
  // already, and the linked files that went with them. Undo restores these.
  removedIds: number[];
}

function asObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      )
    : [];
}

function failureMessage(result: Record<string, unknown>): string | null {
  const message = apiErrorMessage(result, "");
  return message === "" ? null : message;
}

/**
 * Reads the answer to a batch delete. A result with `ok: false` failed. A
 * requested file with `already_applied` counts as done, since two people
 * deleting a file both see it deleted, but it is not in `removedIds`: this call
 * did not delete it, so Undo leaves it alone. The files in `linked` were all
 * deleted by this call.
 */
export function tallyDeleteResponse(body: unknown): DeleteTally {
  const tally: DeleteTally = {
    done: 0,
    failed: 0,
    message: null,
    removedIds: [],
  };
  const { results, linked } = (body ?? {}) as {
    linked?: unknown;
    results?: unknown;
  };
  for (const result of asObjects(results)) {
    if (result.ok === true && typeof result.id === "number") {
      tally.done += 1;
      if (result.already_applied !== true) {
        tally.removedIds.push(result.id);
      }
    } else {
      tally.failed += 1;
      tally.message ??= failureMessage(result);
    }
  }
  for (const file of asObjects(linked)) {
    if (file.ok === true && typeof file.id === "number") {
      tally.done += 1;
      tally.removedIds.push(file.id);
    }
  }
  return tally;
}

/**
 * Reads the answer to a batch restore. Unlike a delete, each linked file has a
 * result of its own, because a linked file can be refused when another file
 * now holds its name.
 */
export function tallyRestoreResponse(body: unknown): FileActionTally {
  const tally: FileActionTally = { done: 0, failed: 0, message: null };
  const { results, linked } = (body ?? {}) as {
    linked?: unknown;
    results?: unknown;
  };
  for (const result of [...asObjects(results), ...asObjects(linked)]) {
    if (result.ok === true) {
      tally.done += 1;
    } else {
      tally.failed += 1;
      tally.message ??= failureMessage(result);
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// One batch of a delete or a restore. A request that fails as a whole counts
// every file in the batch as failed.
async function postBatch(
  url: string,
  fileIds: readonly number[],
  includeLinked: boolean,
  fallbackMessage: string
): Promise<{ body: unknown } | { message: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_ids: fileIds,
        include_linked: includeLinked,
      }),
    });
    const body: unknown = await res.json().catch(() => null);
    return res.ok
      ? { body }
      : { message: apiErrorMessage(body, fallbackMessage) };
  } catch {
    return { message: fallbackMessage };
  }
}

/**
 * Deletes the files in `batches` of a run, with their linked files when
 * `includeLinked` is set, one request a batch. A batch that fails does not stop
 * the next one.
 */
export async function deleteRunFiles(
  instrumentId: string,
  runId: string,
  batches: readonly (readonly number[])[],
  includeLinked: boolean
): Promise<DeleteTally> {
  const total: DeleteTally = {
    done: 0,
    failed: 0,
    message: null,
    removedIds: [],
  };
  for (const batch of batches) {
    const answer = await postBatch(
      runFilesUrl(instrumentId, runId, "delete"),
      batch,
      includeLinked,
      "Couldn't delete the files"
    );
    if ("message" in answer) {
      total.failed += batch.length;
      total.message ??= answer.message;
      continue;
    }
    const tally = tallyDeleteResponse(answer.body);
    total.done += tally.done;
    total.failed += tally.failed;
    total.message ??= tally.message;
    total.removedIds.push(...tally.removedIds);
  }
  return total;
}

/** Restores the files in `batches`, the way `deleteRunFiles` deletes them. */
export async function restoreRunFiles(
  instrumentId: string,
  runId: string,
  batches: readonly (readonly number[])[],
  includeLinked: boolean
): Promise<FileActionTally> {
  const total: FileActionTally = { done: 0, failed: 0, message: null };
  for (const batch of batches) {
    const answer = await postBatch(
      runFilesUrl(instrumentId, runId, "restore"),
      batch,
      includeLinked,
      "Couldn't restore the files"
    );
    if ("message" in answer) {
      total.failed += batch.length;
      total.message ??= answer.message;
      continue;
    }
    const tally = tallyRestoreResponse(answer.body);
    total.done += tally.done;
    total.failed += tally.failed;
    total.message ??= tally.message;
  }
  return total;
}

// A file that goes along with the ones asked about, as a dialog lists it.
export interface LinkedFileInfo {
  filename: string;
  id: number;
  relation: LinkedFileRelation;
  sizeBytes: number | null;
}

/**
 * Reads the linked files out of the answer to GET .../files/linked. Each file
 * is listed once, in the order found, even when two of the files asked about
 * share it, as two raw files in one folder share a sidecar.
 */
export function linkedFilesFromResponse(body: unknown): LinkedFileInfo[] {
  const seen = new Map<number, LinkedFileInfo>();
  for (const group of asObjects(
    (body as { groups?: unknown } | null)?.groups
  )) {
    for (const file of asObjects(group.linked)) {
      if (
        typeof file.id === "number" &&
        typeof file.filename === "string" &&
        typeof file.relation === "string" &&
        !seen.has(file.id)
      ) {
        seen.set(file.id, {
          id: file.id,
          filename: file.filename,
          relation: file.relation as LinkedFileRelation,
          sizeBytes:
            typeof file.size_bytes === "number" ? file.size_bytes : null,
        });
      }
    }
  }
  return [...seen.values()];
}

/**
 * The files that deleting (or restoring) the files in `batches` would take
 * along, one lookup a batch. Pass the batches the delete will send, so that
 * what a dialog lists is what the delete takes. Returns null when a lookup
 * fails, so the dialog can say so and not claim there are none.
 */
export async function fetchLinkedFiles(
  instrumentId: string,
  runId: string,
  batches: readonly (readonly number[])[],
  mode: "delete" | "restore",
  signal?: AbortSignal
): Promise<LinkedFileInfo[] | null> {
  const found = new Map<number, LinkedFileInfo>();
  try {
    for (const batch of batches) {
      const res = await fetch(
        `${runFilesUrl(instrumentId, runId, "linked")}?file_ids=${batch.join(",")}&for=${mode}`,
        { signal }
      );
      if (!res.ok) {
        return null;
      }
      for (const file of linkedFilesFromResponse(await res.json())) {
        if (!found.has(file.id)) {
          found.set(file.id, file);
        }
      }
    }
  } catch {
    return null;
  }
  return [...found.values()];
}
