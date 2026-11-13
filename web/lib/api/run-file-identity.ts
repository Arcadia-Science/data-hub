// Decides the stored name for a file a watcher reports into a run.
// A run holds one active row per filename and one per path. Watchers at 1.1.0
// or newer store a later copy from another folder as `<stem>~<hash>.<ext>`.
// Older watchers still upload by the bare name, so callers keep the old insert.
//
// A dismissed row (`deleted_at` set) holds neither its name nor its path. A
// file reported at a dismissed row's path is stored as a new row when its size
// or creation time differs from that row's, and skipped when both match,
// because a watcher that forgot the file reports the same one again.

import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { touchRuns } from "@/lib/api/touch-runs";
import type { DbExecutor } from "@/lib/db";
import { files } from "@/lib/db/schema";

const TAG_HEX_LENGTH = 8;

export interface IncomingRunFile {
  fileCreatedAt: Date | null;
  filename: string;
  relativePath: string;
  sizeBytes: number | null;
}

export interface StoredRunFile {
  filename: string;
  id: number;
  relativePath: string | null;
}

// What a dismissed row records about the file that was dismissed.
export interface DismissedRunFile {
  fileCreatedAt: Date | null;
  relativePath: string;
  sizeBytes: number | null;
}

export interface ReportedFile {
  file_created_at?: string;
  filename: string;
  relative_path: string;
  size_bytes?: number;
}

export type RunFileResolution =
  | { action: "existing"; fileId: number | null; filename: string }
  | { action: "insert"; filename: string }
  // The same file as a dismissed row at this path. Nothing to store.
  | { action: "dismissed" };

interface NameClaim {
  fileId: number | null;
  filename: string;
  relativePath: string;
}

export function folderOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

/**
 * Inserts `~<hash>` before the last extension. Dotfiles and names with no
 * extension get the suffix appended, so the extension the processors match
 * on stays put (`run.json` → `run~3f9a1c2b.json`).
 *
 * `hexLength` widens the hash when the short form is already a different
 * file's name. Same folder always hashes the same, so a re-report finds
 * the row it created.
 */
export function taggedFilename(
  filename: string,
  relativePath: string,
  hexLength = TAG_HEX_LENGTH
): string {
  const hash = createHash("sha256")
    .update(folderOf(relativePath))
    .digest("hex")
    .slice(0, hexLength);
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) {
    return `${filename}~${hash}`;
  }
  return `${filename.slice(0, dot)}~${hash}${filename.slice(dot)}`;
}

/**
 * Whether `incoming` is the file a dismissed row stands for. They are the same
 * file unless the size or the creation time differs. A value that one side
 * doesn't have (a row from before the watcher reported creation times, or a
 * report without a size) can't show a difference, so only the values both sides
 * have are compared. Creation times compare as milliseconds, the way a stored
 * value comes back: the watcher reports microseconds, and `new Date` drops them
 * before the first insert as well as before this check.
 *
 * Callers pass a row at the same path. The path isn't compared here.
 */
export function isSameAsDismissed(
  incoming: Pick<IncomingRunFile, "fileCreatedAt" | "sizeBytes">,
  dismissed: Pick<DismissedRunFile, "fileCreatedAt" | "sizeBytes">
): boolean {
  if (
    incoming.sizeBytes != null &&
    dismissed.sizeBytes != null &&
    incoming.sizeBytes !== dismissed.sizeBytes
  ) {
    return false;
  }
  if (
    incoming.fileCreatedAt &&
    dismissed.fileCreatedAt &&
    incoming.fileCreatedAt.getTime() !== dismissed.fileCreatedAt.getTime()
  ) {
    return false;
  }
  return true;
}

function groupDismissedByPath(
  dismissed: DismissedRunFile[]
): Map<string, DismissedRunFile[]> {
  const byPath = new Map<string, DismissedRunFile[]>();
  for (const row of dismissed) {
    const atPath = byPath.get(row.relativePath);
    if (atPath) {
      atPath.push(row);
    } else {
      byPath.set(row.relativePath, [row]);
    }
  }
  return byPath;
}

function chooseFilename(
  incoming: IncomingRunFile,
  byName: Map<string, NameClaim>
): string {
  const plain = byName.get(incoming.filename);
  if (!plain || plain.relativePath === incoming.relativePath) {
    return plain?.filename ?? incoming.filename;
  }
  const tagged = taggedFilename(incoming.filename, incoming.relativePath);
  const taggedOwner = byName.get(tagged);
  if (!taggedOwner || taggedOwner.relativePath === incoming.relativePath) {
    return tagged;
  }
  // Eight hex digits collided with a file from another folder. A longer
  // slice of the same hash still identifies this folder on the next report.
  return taggedFilename(incoming.filename, incoming.relativePath, 16);
}

/**
 * Pure decision for one report batch. `existing` is the active rows that
 * already use one of these paths or names. `dismissed` is the dismissed rows at
 * these paths: a file that no active row has is skipped when it is the same as
 * any of them (see `isSameAsDismissed`). Results line up with `incoming`.
 * A name claimed by an earlier item in the batch counts, so two copies
 * reported together don't both try to take the plain name. A skipped file
 * claims nothing, and a dismissed row never claims a name, so a new file may
 * take the name of the file that was dismissed.
 */
export function decideStoredNames(
  incoming: IncomingRunFile[],
  existing: StoredRunFile[],
  dismissed: DismissedRunFile[] = []
): RunFileResolution[] {
  const byPath = new Map<string, NameClaim>();
  const byName = new Map<string, NameClaim>();
  const dismissedByPath = groupDismissedByPath(dismissed);

  for (const row of existing) {
    const claim: NameClaim = {
      fileId: row.id,
      relativePath: row.relativePath ?? row.filename,
      filename: row.filename,
    };
    if (row.relativePath) {
      byPath.set(row.relativePath, claim);
    }
    if (!byName.has(row.filename)) {
      byName.set(row.filename, claim);
    }
  }

  return incoming.map((file) => {
    const knownPath = byPath.get(file.relativePath);
    if (knownPath) {
      return {
        action: "existing" as const,
        fileId: knownPath.fileId,
        filename: knownPath.filename,
      };
    }

    const filename = chooseFilename(file, byName);
    const owner = byName.get(filename);
    if (owner && owner.relativePath === file.relativePath) {
      byPath.set(file.relativePath, owner);
      return {
        action: "existing" as const,
        fileId: owner.fileId,
        filename: owner.filename,
      };
    }

    if (
      dismissedByPath
        .get(file.relativePath)
        ?.some((row) => isSameAsDismissed(file, row))
    ) {
      return { action: "dismissed" as const };
    }

    const claim: NameClaim = {
      fileId: null,
      relativePath: file.relativePath,
      filename,
    };
    byName.set(filename, claim);
    byPath.set(file.relativePath, claim);
    return { action: "insert" as const, filename };
  });
}

function toIncoming(file: ReportedFile): IncomingRunFile {
  return {
    relativePath: file.relative_path,
    filename: file.filename,
    sizeBytes: file.size_bytes ?? null,
    fileCreatedAt: file.file_created_at ? new Date(file.file_created_at) : null,
  };
}

async function loadMatchingFiles(
  executor: DbExecutor,
  instrumentRunId: string,
  paths: string[],
  names: string[]
): Promise<StoredRunFile[]> {
  const matchers: SQL[] = [];
  if (paths.length > 0) {
    matchers.push(inArray(files.relativePath, paths));
  }
  if (names.length > 0) {
    matchers.push(inArray(files.filename, names));
  }
  if (matchers.length === 0) {
    return [];
  }
  return await executor
    .select({
      id: files.id,
      relativePath: files.relativePath,
      filename: files.filename,
    })
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, instrumentRunId),
        isNull(files.deletedAt),
        or(...matchers)
      )
    );
}

// Dismissed rows at the given paths, for a whole batch in one query.
async function loadDismissedFiles(
  executor: DbExecutor,
  instrumentRunId: string,
  paths: string[]
): Promise<DismissedRunFile[]> {
  if (paths.length === 0) {
    return [];
  }
  const rows = await executor
    .select({
      relativePath: files.relativePath,
      sizeBytes: files.sizeBytes,
      fileCreatedAt: files.fileCreatedAt,
    })
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, instrumentRunId),
        isNotNull(files.deletedAt),
        inArray(files.relativePath, paths)
      )
    );
  return rows.flatMap((row) =>
    row.relativePath ? [{ ...row, relativePath: row.relativePath }] : []
  );
}

export async function resolveRunFiles(
  executor: DbExecutor,
  instrumentRunId: string,
  incoming: IncomingRunFile[]
): Promise<RunFileResolution[]> {
  if (incoming.length === 0) {
    return [];
  }
  const paths = [...new Set(incoming.map((file) => file.relativePath))];
  const names = [...new Set(incoming.map((file) => file.filename))];
  const existing = await loadMatchingFiles(
    executor,
    instrumentRunId,
    paths,
    names
  );
  let decisions = decideStoredNames(incoming, existing);

  // A file that no active row has may be one that was dismissed. Only then
  // look at the dismissed rows, so a re-report of known files costs nothing.
  const newPaths = [
    ...new Set(
      incoming
        .filter((_, index) => decisions[index]?.action === "insert")
        .map((file) => file.relativePath)
    ),
  ];
  const dismissed = await loadDismissedFiles(
    executor,
    instrumentRunId,
    newPaths
  );
  if (dismissed.length > 0) {
    decisions = decideStoredNames(incoming, existing, dismissed);
  }

  // The short hash isn't one of the names we queried. Load any row that
  // already uses a chosen name so a re-report maps back to it instead of
  // trying to insert a second row.
  const knownNames = new Set(existing.map((row) => row.filename));
  const extraNames = [
    ...new Set(
      decisions
        .filter((decision) => decision.action === "insert")
        .map((decision) => decision.filename)
        .filter((name) => !knownNames.has(name))
    ),
  ];
  if (extraNames.length === 0) {
    return decisions;
  }
  const extra = await loadMatchingFiles(
    executor,
    instrumentRunId,
    [],
    extraNames
  );
  if (extra.length === 0) {
    return decisions;
  }
  decisions = decideStoredNames(incoming, [...existing, ...extra], dismissed);
  return decisions;
}

async function insertResolved(
  executor: DbExecutor,
  instrumentRunId: string,
  incoming: IncomingRunFile[],
  decisions: RunFileResolution[]
): Promise<Set<string>> {
  const now = new Date();
  const values = incoming.flatMap((file, index) => {
    const decision = decisions[index];
    if (decision?.action !== "insert") {
      return [];
    }
    return [
      {
        instrumentRunId,
        relativePath: file.relativePath,
        filename: decision.filename,
        sizeBytes: file.sizeBytes,
        status: "detected" as const,
        detectedAt: now,
        fileCreatedAt: file.fileCreatedAt,
      },
    ];
  });
  if (values.length === 0) {
    return new Set();
  }
  // `onConflictDoNothing` has no target, so a row another request stored
  // between the read and this insert is skipped rather than raising.
  // Returning the paths tells the caller which ones still need a decision.
  const inserted = await executor
    .insert(files)
    .values(values)
    .onConflictDoNothing()
    .returning({ relativePath: files.relativePath });
  return new Set(
    inserted.flatMap((row) => (row.relativePath ? [row.relativePath] : []))
  );
}

/**
 * Stores watcher-reported files for a run.
 *
 * `renameDuplicates` is true only for watchers that can upload the renamed
 * file. For older watchers the insert is unchanged: a second file with a
 * name already in the run is skipped by the filename unique index. Both kinds
 * leave out a file that a dismissed row at its path stands for.
 */
export async function recordDetectedFiles(
  executor: DbExecutor,
  instrumentRunId: string,
  reported: ReportedFile[],
  renameDuplicates: boolean
): Promise<void> {
  if (reported.length === 0) {
    return;
  }
  // A re-report of files the run already holds is a no-op insert. Only a
  // row that was actually stored should move "Last Updated".
  let insertedAny = false;
  if (renameDuplicates) {
    const incoming = reported.map(toIncoming);
    const decisions = await resolveRunFiles(
      executor,
      instrumentRunId,
      incoming
    );
    const insertedPaths = await insertResolved(
      executor,
      instrumentRunId,
      incoming,
      decisions
    );
    insertedAny = insertedPaths.size > 0;
    const missing = incoming.filter(
      (file, index) =>
        decisions[index]?.action === "insert" &&
        !insertedPaths.has(file.relativePath)
    );
    if (missing.length > 0) {
      // One retry. The first insert lost a race; deciding again sees the
      // winner and either reuses it or picks the folder-hash name.
      const retryDecisions = await resolveRunFiles(
        executor,
        instrumentRunId,
        missing
      );
      const retried = await insertResolved(
        executor,
        instrumentRunId,
        missing,
        retryDecisions
      );
      insertedAny = insertedAny || retried.size > 0;
    }
  } else {
    // The path index no longer holds a dismissed file's path, so leave out
    // the files a dismissed row stands for, as the resolver does.
    const dismissedByPath = groupDismissedByPath(
      await loadDismissedFiles(
        executor,
        instrumentRunId,
        reported.map((file) => file.relative_path)
      )
    );
    const fresh = reported.filter(
      (file) =>
        !dismissedByPath
          .get(file.relative_path)
          ?.some((row) => isSameAsDismissed(toIncoming(file), row))
    );
    if (fresh.length === 0) {
      return;
    }
    const now = new Date();
    const inserted = await executor
      .insert(files)
      .values(
        fresh.map((file) => ({
          instrumentRunId,
          relativePath: file.relative_path,
          filename: file.filename,
          sizeBytes: file.size_bytes ?? null,
          status: "detected" as const,
          detectedAt: now,
          fileCreatedAt: file.file_created_at
            ? new Date(file.file_created_at)
            : null,
        }))
      )
      .onConflictDoNothing()
      .returning({ id: files.id });
    insertedAny = inserted.length > 0;
  }
  if (insertedAny) {
    await touchRuns([instrumentRunId], executor);
  }
}
