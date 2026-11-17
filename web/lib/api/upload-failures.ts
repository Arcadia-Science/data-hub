import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { touchRuns } from "@/lib/api/touch-runs";
import { db } from "@/lib/db";
import { files, instrumentRuns, watcherEvents } from "@/lib/db/schema";
import {
  folderOf,
  UPLOAD_FAILURE_SUMMARY,
  type UploadFailureReason,
  uploadFailureMessage,
} from "@/lib/runs/upload-failure";

// POST /watchers/:id/upload-failures: a watcher reports the files it gave up
// on. Each file moves to `upload_failed` with its reason, and the server logs
// one `uploads_failed` event per run and reason.
//
// Only a file that is still waiting moves:
// - a requested file (`upload_requested`) whose request is the one the watcher
//   tried (`requested_at` matches), so a failure of an earlier request never
//   fails a newer one;
// - an auto-mode file (`detected` with the auto-upload mark), named by run and
//   path because the watcher doesn't know its id.
// Anything else (already failed, uploaded, requested again, dismissed, or in a
// deleted run) is skipped with no event, so a retried report changes nothing.

export interface UploadFailureItem {
  detail?: string;
  file_id?: number;
  reason: UploadFailureReason;
  relative_path?: string;
  requested_at?: string;
  run_id?: string;
}

// One group of files that failed together: same run, same reason. Each
// requester in it gets one notification (`notifyUploadFailed`).
export interface FailedUploadsByRun {
  failedCount: number;
  folder: string | null;
  instrumentRunId: string;
  reason: UploadFailureReason;
  // The people who requested files in this group, for the notification.
  requesterIds: string[];
  runId: string;
}

export interface UploadFailuresResult {
  failed: number;
  groups: FailedUploadsByRun[];
  skipped: number;
}

interface Target {
  detail: string | null;
  fileId: number;
  instrumentRunId: string;
  reason: UploadFailureReason;
  relativePath: string | null;
  requestedBy: string | null;
  runId: string;
}

const pathKey = (runId: string, relativePath: string) =>
  `${runId}\u0000${relativePath}`;

export async function recordUploadFailures(
  watcher: { id: string; instrumentId: string },
  items: UploadFailureItem[]
): Promise<UploadFailuresResult> {
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const liveRunOfInstrument = and(
      eq(instrumentRuns.instrumentId, watcher.instrumentId),
      isNull(instrumentRuns.deletedAt)
    );
    const columns = {
      id: files.id,
      instrumentRunId: files.instrumentRunId,
      relativePath: files.relativePath,
      runId: instrumentRuns.runId,
      uploadRequestedAt: files.uploadRequestedAt,
      uploadRequestedBy: files.uploadRequestedBy,
    };

    // Requested files, locked so a new request can't land between this read
    // and the update.
    const byId = new Map<number, UploadFailureItem>();
    for (const item of items) {
      if (item.file_id !== undefined) {
        byId.set(item.file_id, item);
      }
    }
    const requestedRows =
      byId.size === 0
        ? []
        : await tx
            .select(columns)
            .from(files)
            .innerJoin(
              instrumentRuns,
              eq(files.instrumentRunId, instrumentRuns.id)
            )
            .where(
              and(
                inArray(files.id, [...byId.keys()]),
                liveRunOfInstrument,
                eq(files.status, "upload_requested"),
                isNull(files.uploadedAt),
                isNull(files.deletedAt)
              )
            )
            .for("update", { of: files });

    // Auto-mode files, by run and path.
    const byPath = new Map<string, UploadFailureItem>();
    for (const item of items) {
      if (
        item.file_id === undefined &&
        item.run_id !== undefined &&
        item.relative_path !== undefined
      ) {
        byPath.set(pathKey(item.run_id, item.relative_path), item);
      }
    }
    const pairs: SQL[] = [...byPath.values()].map(
      (item) => sql`(${item.run_id}, ${item.relative_path})`
    );
    const autoRows =
      pairs.length === 0
        ? []
        : await tx
            .select(columns)
            .from(files)
            .innerJoin(
              instrumentRuns,
              eq(files.instrumentRunId, instrumentRuns.id)
            )
            .where(
              and(
                sql`(${instrumentRuns.runId}, ${files.relativePath}) in (${sql.join(pairs, sql`, `)})`,
                liveRunOfInstrument,
                eq(files.status, "detected"),
                isNotNull(files.autoUploadExpectedAt),
                isNull(files.uploadedAt),
                isNull(files.deletedAt)
              )
            )
            .for("update", { of: files });

    const targets: Target[] = [];
    for (const row of requestedRows) {
      const item = byId.get(row.id);
      // The request the watcher tried must still be the current one.
      if (
        !(item?.requested_at && row.uploadRequestedAt) ||
        Date.parse(item.requested_at) !== row.uploadRequestedAt.getTime()
      ) {
        continue;
      }
      targets.push(toTarget(row, item));
    }
    for (const row of autoRows) {
      const item =
        row.relativePath === null
          ? undefined
          : byPath.get(pathKey(row.runId, row.relativePath));
      if (item) {
        targets.push(toTarget(row, item));
      }
    }

    // One update per reason and message: the files of a renamed folder all
    // share both, so a run's files usually move in a single statement.
    const byMessage = new Map<
      string,
      { fileIds: number[]; message: string; reason: UploadFailureReason }
    >();
    for (const target of targets) {
      const message = uploadFailureMessage(
        target.reason,
        folderOf(target.relativePath),
        target.detail
      );
      const key = `${target.reason}\u0000${message}`;
      const batch = byMessage.get(key) ?? {
        fileIds: [],
        message,
        reason: target.reason,
      };
      batch.fileIds.push(target.fileId);
      byMessage.set(key, batch);
    }
    for (const batch of byMessage.values()) {
      await tx
        .update(files)
        .set({
          status: "upload_failed",
          uploadFailureReason: batch.reason,
          uploadFailedAt: now,
          errorMessage: batch.message,
          uploadRequestedAt: null,
          uploadRequestedBy: null,
          autoUploadExpectedAt: null,
        })
        .where(inArray(files.id, batch.fileIds));
    }

    const groups = groupTargets(targets);
    if (groups.length > 0) {
      await tx.insert(watcherEvents).values(
        groups.map((group) => ({
          watcherId: watcher.id,
          eventType: "uploads_failed" as const,
          message: `Couldn't upload ${group.failedCount} ${group.failedCount === 1 ? "file" : "files"} in run ${group.runId}: ${UPLOAD_FAILURE_SUMMARY[group.reason]}`,
          details: {
            kind: "uploads_failed",
            run_id: group.runId,
            reason: group.reason,
            folder: group.folder,
            failed_count: group.failedCount,
          },
          timestamp: now,
        }))
      );
      await touchRuns(
        groups.map((group) => group.instrumentRunId),
        tx
      );
    }

    return { groups, failed: targets.length };
  });

  return {
    failed: result.failed,
    groups: result.groups,
    skipped: items.length - result.failed,
  };
}

function toTarget(
  row: {
    id: number;
    instrumentRunId: string;
    relativePath: string | null;
    runId: string;
    uploadRequestedBy: string | null;
  },
  item: UploadFailureItem
): Target {
  return {
    detail: item.detail?.trim() || null,
    fileId: row.id,
    instrumentRunId: row.instrumentRunId,
    reason: item.reason,
    relativePath: row.relativePath,
    requestedBy: row.uploadRequestedBy,
    runId: row.runId,
  };
}

// One group per run and reason. The folder is kept when every file in the
// group sits in the same one, which is the usual case (a renamed run folder).
function groupTargets(targets: Target[]): FailedUploadsByRun[] {
  const groups = new Map<
    string,
    FailedUploadsByRun & {
      folders: Set<string | null>;
      requesters: Set<string>;
    }
  >();
  for (const target of targets) {
    const key = `${target.instrumentRunId}\u0000${target.reason}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        failedCount: 0,
        folder: null,
        folders: new Set(),
        instrumentRunId: target.instrumentRunId,
        reason: target.reason,
        requesterIds: [],
        requesters: new Set(),
        runId: target.runId,
      };
      groups.set(key, group);
    }
    group.failedCount += 1;
    group.folders.add(folderOf(target.relativePath));
    if (target.requestedBy) {
      group.requesters.add(target.requestedBy);
    }
  }
  return [...groups.values()].map(({ folders, requesters, ...group }) => ({
    ...group,
    folder: folders.size === 1 ? ([...folders][0] ?? null) : null,
    requesterIds: [...requesters],
  }));
}
