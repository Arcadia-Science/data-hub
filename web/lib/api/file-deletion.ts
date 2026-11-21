// Deleting and restoring individual files of a run. One function for each,
// shared by REST and MCP, so every way in follows the same rules.
//
// A delete is soft. It sets `files.deleted_at` and records who did it (a user in
// `deleted_by`, or a token in `deleted_by_token`), and a restore clears those
// three columns again. Nothing here removes a row or an S3 object: a deleted
// file keeps its stored name, so the same file reported again stays deleted and
// a different file at that path is stored under a new name (see
// `run-file-identity.ts`).

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type ActorRef, actorColumns } from "@/lib/api/actor";
import { RUN_DELETED_REASON } from "@/lib/api/errors";
import { folderSql, isSidecarSql } from "@/lib/api/file-link-sql";
import type { FileRow } from "@/lib/api/files";
import { touchRuns } from "@/lib/api/touch-runs";
import { revertPendingUploadRequests } from "@/lib/api/watchers";
import { type DbExecutor, db } from "@/lib/db";
import { hasPgErrorCode, UNIQUE_VIOLATION } from "@/lib/db/pg-error";
import { files, instrumentRuns } from "@/lib/db/schema";
import {
  folderOfPath,
  isSidecarFilename,
  type LinkedFileRelation,
  outputRelation,
  pathOf,
} from "@/lib/runs/file-links";
import { isStalledProcessing } from "@/lib/runs/stalled-processing";

// ---------------------------------------------------------------------------
// Linked files
// ---------------------------------------------------------------------------

export interface LinkedFile {
  category: FileRow["category"];
  deletedAt: Date | null;
  filename: string;
  id: number;
  relation: LinkedFileRelation;
  relativePath: string | null;
  sizeBytes: number | null;
}

// The files linked to one of the files asked about.
export interface LinkedFilesGroup {
  fileId: number;
  linked: LinkedFile[];
}

const linkColumns = {
  id: files.id,
  instrumentRunId: files.instrumentRunId,
  category: files.category,
  filename: files.filename,
  relativePath: files.relativePath,
  sizeBytes: files.sizeBytes,
  contentType: files.contentType,
  deletedAt: files.deletedAt,
  sourceFileId: files.sourceFileId,
};

type LinkRow = Pick<FileRow, keyof typeof linkColumns>;

function toLinked(row: LinkRow, relation: LinkedFileRelation): LinkedFile {
  return {
    id: row.id,
    filename: row.filename,
    relativePath: row.relativePath,
    sizeBytes: row.sizeBytes,
    category: row.category,
    deletedAt: row.deletedAt,
    relation,
  };
}

// The sidecars in the runs and folders of a set of raw files. The caller
// matches each one to the raw files of its own run and folder.
async function loadSidecars(
  executor: DbExecutor,
  rows: LinkRow[],
  deleted: boolean
): Promise<LinkRow[]> {
  const runIds = [...new Set(rows.map((row) => row.instrumentRunId))];
  const folders = [...new Set(rows.map((row) => folderOfPath(pathOf(row))))];
  return await executor
    .select(linkColumns)
    .from(files)
    .where(
      and(
        inArray(files.instrumentRunId, runIds),
        eq(files.category, "raw"),
        isSidecarSql,
        deleted ? isNotNull(files.deletedAt) : isNull(files.deletedAt),
        inArray(folderSql, folders)
      )
    );
}

// The folders (as "<run>\0<folder>") where a raw file outside `requested`
// stays active. A sidecar there still serves a file that is staying.
async function foldersWithOtherRawFiles(
  executor: DbExecutor,
  rows: LinkRow[],
  requested: ReadonlySet<number>
): Promise<Set<string>> {
  const runIds = [...new Set(rows.map((row) => row.instrumentRunId))];
  const folders = [...new Set(rows.map((row) => folderOfPath(pathOf(row))))];
  const others = await executor
    .select({
      instrumentRunId: files.instrumentRunId,
      filename: files.filename,
      relativePath: files.relativePath,
      id: files.id,
    })
    .from(files)
    .where(
      and(
        inArray(files.instrumentRunId, runIds),
        eq(files.category, "raw"),
        isNull(files.deletedAt),
        sql`not (${isSidecarSql})`,
        inArray(folderSql, folders)
      )
    );
  return new Set(
    others
      .filter((other) => !requested.has(other.id))
      .map((other) => folderKey(other.instrumentRunId, pathOf(other)))
  );
}

function folderKey(runId: string, relativePath: string): string {
  return `${runId}\u0000${folderOfPath(relativePath)}`;
}

/**
 * The files that go along with `fileIds`, grouped by the file they belong to.
 *
 * `delete` mode finds what a delete offers to take too, all of it still active:
 * - the processed files made from a raw file (`source_file_id`), and
 * - the sidecar saved with its capture, only when every raw file in the
 *   sidecar's folder is among `fileIds`. A folder that keeps a raw file keeps
 *   its sidecar.
 * Files already deleted are skipped, and so are files that are in `fileIds`.
 *
 * `restore` mode finds the deleted counterparts of deleted files:
 * - the deleted processed files made from a raw file,
 * - the raw file a deleted processed file was made from, and
 * - the deleted sidecar of a raw file's folder, when any raw file there comes
 *   back.
 *
 * A processed file records one source, so an output made from several raw
 * files has none and is never linked: it stays active when one of them goes.
 */
export async function findLinkedFiles(
  fileIds: readonly number[],
  options: { mode: "delete" | "restore" },
  executor: DbExecutor = db
): Promise<LinkedFilesGroup[]> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) {
    return [];
  }
  const deleting = options.mode === "delete";
  const requested = new Set(ids);

  // Only files in the state the mode acts on have anything to bring along.
  const rows = (
    await executor.select(linkColumns).from(files).where(inArray(files.id, ids))
  ).filter((row) => (row.deletedAt === null) === deleting);
  const raws = rows.filter(
    (row) => row.category === "raw" && !isSidecarFilename(row.filename)
  );

  const groups = new Map<number, LinkedFile[]>();
  const add = (fileId: number, file: LinkedFile) => {
    if (requested.has(file.id)) {
      return;
    }
    groups.set(fileId, [...(groups.get(fileId) ?? []), file]);
  };

  if (raws.length > 0) {
    const outputs = await executor
      .select(linkColumns)
      .from(files)
      .where(
        and(
          inArray(
            files.sourceFileId,
            raws.map((row) => row.id)
          ),
          deleting ? isNull(files.deletedAt) : isNotNull(files.deletedAt)
        )
      )
      .orderBy(asc(files.id));
    for (const output of outputs) {
      if (output.sourceFileId !== null) {
        add(output.sourceFileId, toLinked(output, outputRelation(output)));
      }
    }

    const sidecars = await loadSidecars(executor, raws, !deleting);
    const blocked = deleting
      ? await foldersWithOtherRawFiles(executor, raws, requested)
      : new Set<string>();
    for (const raw of raws) {
      const key = folderKey(raw.instrumentRunId, pathOf(raw));
      if (blocked.has(key)) {
        continue;
      }
      for (const sidecar of sidecars) {
        if (folderKey(sidecar.instrumentRunId, pathOf(sidecar)) === key) {
          add(raw.id, toLinked(sidecar, "sidecar"));
        }
      }
    }
  }

  if (!deleting) {
    const processed = rows.filter(
      (row) => row.category === "processed" && row.sourceFileId !== null
    );
    if (processed.length > 0) {
      const sources = await executor
        .select(linkColumns)
        .from(files)
        .where(
          and(
            inArray(
              files.id,
              processed.flatMap((row) =>
                row.sourceFileId === null ? [] : [row.sourceFileId]
              )
            ),
            isNotNull(files.deletedAt)
          )
        );
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      for (const row of processed) {
        const source =
          row.sourceFileId === null
            ? undefined
            : sourceById.get(row.sourceFileId);
        if (source) {
          add(row.id, toLinked(source, "made_from"));
        }
      }
    }
  }

  return [...groups].map(([fileId, linked]) => ({ fileId, linked }));
}

// Every linked file once, in the order found. A sidecar shared by two raw
// files of its folder is listed under both, and only once here.
export function uniqueLinkedFiles(groups: LinkedFilesGroup[]): LinkedFile[] {
  const seen = new Map<number, LinkedFile>();
  for (const group of groups) {
    for (const file of group.linked) {
      if (!seen.has(file.id)) {
        seen.set(file.id, file);
      }
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export interface FileActionFailure {
  code: "NOT_FOUND" | "CONFLICT";
  details?: Record<string, unknown>;
  // The file's name, when the file exists.
  filename?: string;
  id: number;
  message: string;
  ok: false;
  status: 404 | 409;
}

// The result for an ID that names no file, or no file of the run asked about.
export function notFound(id: number): FileActionFailure {
  return {
    ok: false,
    id,
    status: 404,
    code: "NOT_FOUND",
    message: `File '${id}' not found`,
  };
}

function runDeleted(
  file: FileRow,
  what: "delete" | "restore"
): FileActionFailure {
  return {
    ok: false,
    id: file.id,
    filename: file.filename,
    status: 409,
    code: "CONFLICT",
    message: `Cannot ${what} files of a deleted run. Restore the run first.`,
    details: { reason: RUN_DELETED_REASON },
  };
}

// The handle `db.transaction` passes to its callback. Unlike `DbExecutor`, it
// is known to open a nested transaction, which Postgres runs as a savepoint.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface LockedRun {
  deletedAt: Date | null;
  instrumentId: string;
}

// Locks the runs of the files the transaction already holds, in ID order. The
// lock keeps a run from being deleted while its files change, and the other way
// round: `softDeleteRun` takes the same lock when it updates the run. It locks
// files first and the run second, as this does, so the two can't wait for each
// other.
async function lockRuns(
  tx: DbExecutor,
  runIds: readonly string[]
): Promise<Map<string, LockedRun>> {
  const unique = [...new Set(runIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({
      id: instrumentRuns.id,
      deletedAt: instrumentRuns.deletedAt,
      instrumentId: instrumentRuns.instrumentId,
    })
    .from(instrumentRuns)
    .where(inArray(instrumentRuns.id, unique))
    .orderBy(asc(instrumentRuns.id))
    .for("no key update");
  return new Map(
    rows.map((row) => [
      row.id,
      { deletedAt: row.deletedAt, instrumentId: row.instrumentId },
    ])
  );
}

// A file that is queued or processing can't be deleted: the processor is about
// to write to it. A processing file past the stall limit has no processor
// behind it any more, so it can go.
function refusedWhileProcessing(file: FileRow, now: Date): boolean {
  return (
    file.status === "queued" ||
    (file.status === "processing" && !isStalledProcessing(file, now))
  );
}

function processingRefusal(file: FileRow): FileActionFailure {
  return {
    ok: false,
    id: file.id,
    filename: file.filename,
    status: 409,
    code: "CONFLICT",
    message: `Cannot delete '${file.filename}' while it is ${file.status}. Wait for processing to finish.`,
    details: { reason: "file_processing", status: file.status },
  };
}

async function lockFiles(
  tx: DbExecutor,
  ids: readonly number[],
  where?: SQL
): Promise<FileRow[]> {
  if (ids.length === 0) {
    return [];
  }
  return await tx
    .select()
    .from(files)
    .where(and(inArray(files.id, [...ids]), where))
    .orderBy(asc(files.id))
    .for("update");
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export type DeleteFileResult =
  | {
      ok: true;
      id: number;
      filename: string;
      deletedAt: Date;
      // The user or token that deleted it. Both null for a file deleted
      // before the actor was recorded, or by a caller with no user.
      deletedBy: string | null;
      deletedByToken: string | null;
      // True when the file was already deleted, so the call changed nothing.
      // A second delete is a success, so two people deleting one file both
      // see it done.
      alreadyApplied: boolean;
    }
  | FileActionFailure;

export interface DeletedLinkedFile {
  deletedAt: Date;
  filename: string;
  id: number;
  relation: LinkedFileRelation;
}

export interface DeleteFilesOutcome {
  // The files that were deleted along with the requested ones, when
  // `includeLinked` was set. Files already deleted are not in it.
  linked: DeletedLinkedFile[];
  // One result per requested file ID, in the order given, repeats dropped.
  results: DeleteFileResult[];
}

/**
 * Soft-deletes files in any state a person can see them in. Records `actor`
 * and moves the run's "Last Updated". All in one transaction, and each file
 * gets its own result, so one that can't be deleted doesn't stop the others.
 *
 * - A file of a deleted run is refused (409, `details.reason: "run_deleted"`).
 * - A file that is queued or processing is refused (409, `file_processing`)
 *   unless its processing stalled.
 * - A file that is already deleted succeeds with `alreadyApplied`.
 * - A file waiting for an upload has its request cancelled, so it reads "Not
 *   uploaded" when it comes back. That records no watcher event: the watcher's
 *   queue never lists a deleted file.
 * - With `includeLinked`, the active files from `findLinkedFiles` go too. A
 *   linked file that is still being processed is left alone.
 *
 * The requested files are locked in ID order, then their linked files, and the
 * runs last. Every other path that changes files and then their run takes the
 * file locks first too, so overlapping calls queue up instead of deadlocking.
 */
export async function deleteFiles(
  fileIds: readonly number[],
  actor: ActorRef | null,
  options: { includeLinked: boolean }
): Promise<DeleteFilesOutcome> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) {
    return { results: [], linked: [] };
  }

  return await db.transaction(async (tx) => {
    const rows = await lockFiles(tx, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const now = new Date();
    const { userId, tokenId } = actorColumns(actor);

    // The linked files are found from the files that can go, and locked before
    // the runs, so that every file lock comes before its run's lock. One that
    // was refused stays active, so a sidecar it still needs stays too. A file
    // of a deleted run can be among them until the runs are read below. That
    // drops it, and its linked files with it, since they are always in its
    // run.
    const linkedRelations = new Map<number, LinkedFileRelation>();
    let linkedRows: FileRow[] = [];
    const candidates = rows.filter(
      (row) => row.deletedAt === null && !refusedWhileProcessing(row, now)
    );
    if (options.includeLinked && candidates.length > 0) {
      const groups = await findLinkedFiles(
        candidates.map((row) => row.id),
        { mode: "delete" },
        tx
      );
      for (const linked of uniqueLinkedFiles(groups)) {
        linkedRelations.set(linked.id, linked.relation);
      }
      linkedRows = (
        await lockFiles(
          tx,
          [...linkedRelations.keys()],
          isNull(files.deletedAt)
        )
      ).filter((row) => !refusedWhileProcessing(row, now));
    }

    const runs = await lockRuns(
      tx,
      [...rows, ...linkedRows].map((row) => row.instrumentRunId)
    );
    const inLiveRun = (row: FileRow) =>
      !runs.get(row.instrumentRunId)?.deletedAt;
    linkedRows = linkedRows.filter(inLiveRun);

    const results = new Map<number, DeleteFileResult>();
    const toDelete: FileRow[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        results.set(id, notFound(id));
      } else if (!inLiveRun(row)) {
        results.set(id, runDeleted(row, "delete"));
      } else if (row.deletedAt) {
        results.set(id, {
          ok: true,
          id,
          filename: row.filename,
          deletedAt: row.deletedAt,
          deletedBy: row.deletedBy,
          deletedByToken: row.deletedByToken,
          alreadyApplied: true,
        });
      } else if (refusedWhileProcessing(row, now)) {
        results.set(id, processingRefusal(row));
      } else {
        toDelete.push(row);
      }
    }

    const everyRow = [...toDelete, ...linkedRows];
    if (everyRow.length > 0) {
      // Cancel upload requests first. The cancel only touches files that are
      // not deleted yet.
      const byInstrument = new Map<string, number[]>();
      for (const row of everyRow) {
        const instrumentId = runs.get(row.instrumentRunId)?.instrumentId;
        if (instrumentId !== undefined) {
          byInstrument.set(instrumentId, [
            ...(byInstrument.get(instrumentId) ?? []),
            row.id,
          ]);
        }
      }
      for (const [instrumentId, instrumentFileIds] of byInstrument) {
        await revertPendingUploadRequests(
          instrumentId,
          tx,
          undefined,
          instrumentFileIds
        );
      }

      const deleted = await tx
        .update(files)
        .set({ deletedAt: now, deletedBy: userId, deletedByToken: tokenId })
        .where(
          and(
            inArray(
              files.id,
              everyRow.map((row) => row.id)
            ),
            isNull(files.deletedAt)
          )
        )
        .returning({ id: files.id, runId: files.instrumentRunId });
      await touchRuns(
        deleted.map((row) => row.runId),
        tx
      );
    }

    for (const row of toDelete) {
      results.set(row.id, {
        ok: true,
        id: row.id,
        filename: row.filename,
        deletedAt: now,
        deletedBy: userId,
        deletedByToken: tokenId,
        alreadyApplied: false,
      });
    }
    return {
      results: ids.map((id) => results.get(id) ?? notFound(id)),
      linked: linkedRows.map((row) => ({
        id: row.id,
        filename: row.filename,
        deletedAt: now,
        relation: linkedRelations.get(row.id) ?? "output",
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export type RestoreFileResult =
  | {
      ok: true;
      id: number;
      filename: string;
      // True when the file was not deleted, so the call changed nothing.
      alreadyApplied: boolean;
    }
  | FileActionFailure;

export type RestoredLinkedFile = RestoreFileResult & {
  relation: LinkedFileRelation;
};

export interface RestoreFilesOutcome {
  // The deleted counterparts that were restored with the requested files, or
  // that couldn't be, when `includeLinked` was set.
  linked: RestoredLinkedFile[];
  // One result per requested file ID, in the order given, repeats dropped.
  results: RestoreFileResult[];
}

interface HeldBy {
  filename: string;
  id: number;
  relativePath: string | null;
}

// The file of `file`'s run that a restore would collide with:
// - an active file with its name or its path. The partial unique indexes on
//   the filename and the path of active rows forbid two.
// - for a file that never reached storage, a deleted file whose stored object
//   has its name. The restored file would upload under the same S3 key and
//   overwrite that object, which a deleted file's object never is. The
//   watcher's held-name rules (`run-file-identity.ts`) give a new file a
//   different name for the same reason.
async function findHolder(
  executor: DbExecutor,
  file: FileRow
): Promise<HeldBy | null> {
  const sameName = [eq(files.filename, file.filename)];
  if (file.relativePath !== null) {
    sameName.push(eq(files.relativePath, file.relativePath));
  }
  const holds = [and(isNull(files.deletedAt), or(...sameName))];
  if (file.s3Key === null) {
    holds.push(
      and(
        isNotNull(files.deletedAt),
        isNotNull(files.s3Key),
        eq(files.filename, file.filename)
      )
    );
  }
  const [holder] = await executor
    .select({
      id: files.id,
      filename: files.filename,
      relativePath: files.relativePath,
    })
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, file.instrumentRunId),
        ne(files.id, file.id),
        or(...holds)
      )
    )
    // An active holder first: it is the one the person can act on.
    .orderBy(sql`${files.deletedAt} is null desc`, asc(files.id))
    .limit(1);
  return holder ?? null;
}

function pathHeld(file: FileRow, holder: HeldBy | null): FileActionFailure {
  const named = holder
    ? ` File ${holder.id} ('${holder.filename}') uses it.`
    : "";
  return {
    ok: false,
    id: file.id,
    filename: file.filename,
    status: 409,
    code: "CONFLICT",
    message: `Cannot restore '${file.filename}': another file in this run now uses its name or path.${named}`,
    details: {
      reason: "path_in_use",
      ...(holder && {
        held_by: {
          id: holder.id,
          filename: holder.filename,
          relative_path: holder.relativePath,
        },
      }),
    },
  };
}

// Restores one deleted file inside its own savepoint, so a collision that the
// unique indexes catch fails this file and leaves the rest of the batch alone.
async function restoreOne(tx: Tx, file: FileRow): Promise<RestoreFileResult> {
  const holder = await findHolder(tx, file);
  if (holder) {
    return pathHeld(file, holder);
  }
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint
        .update(files)
        .set({ deletedAt: null, deletedBy: null, deletedByToken: null })
        .where(and(eq(files.id, file.id), isNotNull(files.deletedAt)));
    });
  } catch (error) {
    // Another request took the name between the check and the update.
    if (hasPgErrorCode(error, UNIQUE_VIOLATION)) {
      return pathHeld(file, await findHolder(tx, file));
    }
    throw error;
  }
  return {
    ok: true,
    id: file.id,
    filename: file.filename,
    alreadyApplied: false,
  };
}

/**
 * Restores deleted files: clears `deleted_at`, `deleted_by` and
 * `deleted_by_token` and moves the run's "Last Updated". Each file gets its own
 * result, so one that can't come back doesn't stop the others.
 *
 * - A file of a deleted run is refused (409, `details.reason: "run_deleted"`).
 * - A file that isn't deleted succeeds with `alreadyApplied`.
 * - A file whose name or path an active file of its run now holds is refused
 *   (409, `details.reason: "path_in_use"`), naming that file in
 *   `details.held_by`. The partial unique indexes make the same call if another
 *   request gets there first. So is a file that never reached storage when a
 *   deleted file's stored object has its name, because its upload would
 *   overwrite that object.
 * - With `includeLinked`, the deleted files from `findLinkedFiles` come back
 *   too, and each of them can be refused the same way.
 *
 * `_actor` is who restores. Nothing records it: a restore clears the delete's
 * columns and keeps no history of either. It is a parameter so the call has the
 * same shape as `deleteFiles`.
 */
export async function restoreFiles(
  fileIds: readonly number[],
  _actor: ActorRef | null,
  options: { includeLinked: boolean }
): Promise<RestoreFilesOutcome> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) {
    return { results: [], linked: [] };
  }

  return await db.transaction(async (tx) => {
    const rows = await lockFiles(tx, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // As in `deleteFiles`, the linked files are locked before the runs, and
    // the ones in a deleted run are dropped once the runs are read.
    const linkedRelations = new Map<number, LinkedFileRelation>();
    let linkedRows: FileRow[] = [];
    const candidates = rows.filter((row) => row.deletedAt !== null);
    if (options.includeLinked && candidates.length > 0) {
      const groups = await findLinkedFiles(
        candidates.map((row) => row.id),
        { mode: "restore" },
        tx
      );
      for (const linked of uniqueLinkedFiles(groups)) {
        linkedRelations.set(linked.id, linked.relation);
      }
      linkedRows = await lockFiles(
        tx,
        [...linkedRelations.keys()],
        isNotNull(files.deletedAt)
      );
    }

    const runs = await lockRuns(
      tx,
      [...rows, ...linkedRows].map((row) => row.instrumentRunId)
    );
    const inLiveRun = (row: FileRow) =>
      !runs.get(row.instrumentRunId)?.deletedAt;
    linkedRows = linkedRows.filter(inLiveRun);

    const results = new Map<number, RestoreFileResult>();
    const toRestore: FileRow[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        results.set(id, notFound(id));
      } else if (!inLiveRun(row)) {
        results.set(id, runDeleted(row, "restore"));
      } else if (row.deletedAt === null) {
        results.set(id, {
          ok: true,
          id,
          filename: row.filename,
          alreadyApplied: true,
        });
      } else {
        toRestore.push(row);
      }
    }

    // One at a time, in the order asked, linked files last. A name that two
    // files in the batch both want goes to the first.
    const restoredRuns: string[] = [];
    for (const row of toRestore) {
      const result = await restoreOne(tx, row);
      results.set(row.id, result);
      if (result.ok) {
        restoredRuns.push(row.instrumentRunId);
      }
    }
    const linked: RestoredLinkedFile[] = [];
    for (const row of linkedRows) {
      const result = await restoreOne(tx, row);
      if (result.ok) {
        restoredRuns.push(row.instrumentRunId);
      }
      linked.push({
        ...result,
        relation: linkedRelations.get(row.id) ?? "output",
      });
    }
    await touchRuns(restoredRuns, tx);

    return {
      results: ids.map((id) => results.get(id) ?? notFound(id)),
      linked,
    };
  });
}
