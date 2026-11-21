// Deleting, restoring and looking up the linked files of several files of one
// run, for the REST routes and the MCP tools. `file-deletion.ts` works on file
// IDs alone. This adds what a request with a run in it needs: the run must
// exist, a file that belongs to another run counts as not found, and a deleted
// file's deleter is named the way the runs API names a run's.

import { and, eq, inArray } from "drizzle-orm";
import type { ActorRef } from "@/lib/api/actor";
import {
  loadTokenRefs,
  type TokenRef,
  tokenRefFor,
} from "@/lib/api/file-deleters";
import {
  type DeletedLinkedFile,
  type DeleteFileResult,
  deleteFiles,
  type FileActionFailure,
  notFound as fileNotFound,
  findLinkedFiles,
  type LinkedFilesGroup,
  type RestoredLinkedFile,
  type RestoreFileResult,
  restoreFiles,
} from "@/lib/api/file-deletion";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";

// A delete result with the token that deleted the file named.
export type FileDeleteOutcome =
  | (Omit<Extract<DeleteFileResult, { ok: true }>, "deletedByToken"> & {
      // The token that deleted it, or null when a person did, or when nobody
      // was recorded. `deletedBy` is the person's user ID.
      deletedByToken: TokenRef | null;
    })
  | FileActionFailure;

/**
 * Names the tokens in a set of delete results, with one query for all of them.
 * A result keeps only the token's ID, and a response names it the way the runs
 * API names the token that deleted a run.
 */
export async function nameDeleters(
  results: readonly DeleteFileResult[]
): Promise<FileDeleteOutcome[]> {
  const tokens = await loadTokenRefs(
    results.map((result) => (result.ok ? result.deletedByToken : null))
  );
  return results.map((result) =>
    result.ok
      ? {
          ...result,
          deletedByToken: tokenRefFor(tokens, result.deletedByToken),
        }
      : result
  );
}

export interface DeleteCounts {
  alreadyDeleted: number;
  deleted: number;
  failed: number;
}

export interface RestoreCounts {
  alreadyRestored: number;
  failed: number;
  restored: number;
}

function countDeleted(results: readonly FileDeleteOutcome[]): DeleteCounts {
  const counts = { deleted: 0, alreadyDeleted: 0, failed: 0 };
  for (const result of results) {
    if (!result.ok) {
      counts.failed += 1;
    } else if (result.alreadyApplied) {
      counts.alreadyDeleted += 1;
    } else {
      counts.deleted += 1;
    }
  }
  return counts;
}

function countRestored(results: readonly RestoreFileResult[]): RestoreCounts {
  const counts = { restored: 0, alreadyRestored: 0, failed: 0 };
  for (const result of results) {
    if (!result.ok) {
      counts.failed += 1;
    } else if (result.alreadyApplied) {
      counts.alreadyRestored += 1;
    } else {
      counts.restored += 1;
    }
  }
  return counts;
}

// What a run-scoped call returns when the run is missing, in the shape
// `apiErrorFromResult` takes.
export interface RunNotFound {
  code: "NOT_FOUND";
  message: string;
  ok: false;
  status: 404;
}

export type RunFilesResult<T> =
  | ({ ok: true; instrumentId: string; runId: string } & T)
  | RunNotFound;

interface RunScope {
  id: string;
  instrumentId: string;
  runId: string;
}

async function findRun(
  instrumentId: string,
  runId: string
): Promise<RunScope | RunNotFound> {
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: `Run '${runId}' not found for instrument '${instrumentId}'`,
    };
  }
  return { id: run.id, instrumentId: run.instrumentId, runId: run.runId };
}

// The IDs among `ids` that are files of the run. Anything else, such as a file
// of another run or an ID that exists nowhere, is not found as far as this run
// is concerned.
async function idsInRun(
  runUuid: string,
  ids: readonly number[]
): Promise<Set<number>> {
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(eq(files.instrumentRunId, runUuid), inArray(files.id, [...ids]))
    );
  return new Set(rows.map((row) => row.id));
}

function uniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

// What a delete or a restore of some files of one run takes. `actor` is the
// person or token that acts, or null when there is none to record.
export interface RunFilesInput {
  actor: ActorRef | null;
  fileIds: readonly number[];
  includeLinked: boolean;
  instrumentId: string;
  runId: string;
}

export type DeleteRunFilesResult = RunFilesResult<{
  counts: DeleteCounts;
  // The files deleted along with the requested ones, when `includeLinked` was
  // set.
  linked: DeletedLinkedFile[];
  // One result per requested file ID, in the order given, repeats dropped.
  results: FileDeleteOutcome[];
}>;

/**
 * `deleteFiles` for some files of one run. Each file gets its own result, in
 * the order asked, so a file that can't be deleted doesn't stop the others. An
 * ID that isn't a file of this run is not found. The result is `ok: false` only
 * when the run itself doesn't exist.
 */
export async function deleteRunFiles(
  input: RunFilesInput
): Promise<DeleteRunFilesResult> {
  const run = await findRun(input.instrumentId, input.runId);
  if ("ok" in run) {
    return run;
  }
  const ids = uniqueIds(input.fileIds);
  const inRun = await idsInRun(run.id, ids);
  const outcome = await deleteFiles(
    ids.filter((id) => inRun.has(id)),
    input.actor,
    { includeLinked: input.includeLinked }
  );
  const byId = new Map(outcome.results.map((result) => [result.id, result]));
  const results = await nameDeleters(
    ids.map((id) => byId.get(id) ?? fileNotFound(id))
  );
  return {
    ok: true,
    instrumentId: run.instrumentId,
    runId: run.runId,
    results,
    linked: outcome.linked,
    counts: countDeleted(results),
  };
}

export type RestoreRunFilesResult = RunFilesResult<{
  counts: RestoreCounts;
  // The deleted counterparts of the requested files, when `includeLinked` was
  // set. Each one can be refused like a requested file.
  linked: RestoredLinkedFile[];
  results: RestoreFileResult[];
}>;

/** `restoreFiles` for some files of one run, with the same rules as `deleteRunFiles`. */
export async function restoreRunFiles(
  input: RunFilesInput
): Promise<RestoreRunFilesResult> {
  const run = await findRun(input.instrumentId, input.runId);
  if ("ok" in run) {
    return run;
  }
  const ids = uniqueIds(input.fileIds);
  const inRun = await idsInRun(run.id, ids);
  const outcome = await restoreFiles(
    ids.filter((id) => inRun.has(id)),
    input.actor,
    { includeLinked: input.includeLinked }
  );
  const byId = new Map(outcome.results.map((result) => [result.id, result]));
  const results = ids.map((id) => byId.get(id) ?? fileNotFound(id));
  return {
    ok: true,
    instrumentId: run.instrumentId,
    runId: run.runId,
    results,
    linked: outcome.linked,
    counts: countRestored(results),
  };
}

export interface LinkedRunFilesInput {
  fileIds: readonly number[];
  instrumentId: string;
  mode: "delete" | "restore";
  runId: string;
}

/**
 * `findLinkedFiles` for some files of one run, for the dialog that offers to
 * take them along. An ID that isn't a file of this run is left out, so a run
 * never shows another run's files.
 */
export async function findRunLinkedFiles(
  input: LinkedRunFilesInput
): Promise<RunFilesResult<{ groups: LinkedFilesGroup[] }>> {
  const run = await findRun(input.instrumentId, input.runId);
  if ("ok" in run) {
    return run;
  }
  const ids = uniqueIds(input.fileIds);
  const inRun = await idsInRun(run.id, ids);
  const groups = await findLinkedFiles(
    ids.filter((id) => inRun.has(id)),
    { mode: input.mode }
  );
  return {
    ok: true,
    instrumentId: run.instrumentId,
    runId: run.runId,
    groups,
  };
}
