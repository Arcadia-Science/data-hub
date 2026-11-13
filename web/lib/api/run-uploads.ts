import { and, eq, inArray, isNull } from "drizzle-orm";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { instrumentHasOnlineWatcher } from "@/lib/api/instruments";
import { touchRuns } from "@/lib/api/touch-runs";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";

export const MAX_UPLOAD_FILE_IDS = 100;

const DELETED_RUN_MESSAGE = "Cannot request uploads for a soft-deleted run";

// A condition for the UPDATE that queues files: the run is not deleted. The
// check in `prepareUploadTarget` runs before the UPDATE, so a delete that lands
// in between would otherwise let the request queue files of a deleted run.
// With this condition that request changes nothing.
function runIsLive(runUuid: string) {
  return inArray(
    files.instrumentRunId,
    db
      .select({ id: instrumentRuns.id })
      .from(instrumentRuns)
      .where(
        and(eq(instrumentRuns.id, runUuid), isNull(instrumentRuns.deletedAt))
      )
  );
}

// True when the run has been deleted since the request began.
async function runWasDeleted(runUuid: string): Promise<boolean> {
  const [row] = await db
    .select({ deletedAt: instrumentRuns.deletedAt })
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, runUuid))
    .limit(1);
  return row?.deletedAt != null;
}

// Runs when the UPDATE queued fewer files than were asked for. A deleted run
// and a file that changed state are 409 conflicts, like a request that arrives
// after the change. A skipped file that is now `upload_requested` is fine: a
// second request for the same files may have queued it a moment earlier, and
// asking twice has always worked.
async function explainSkippedFiles(
  runUuid: string,
  wanted: number[],
  queued: number[]
): Promise<UploadPrepError | null> {
  if (await runWasDeleted(runUuid)) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: DELETED_RUN_MESSAGE,
    };
  }
  const queuedIds = new Set(queued);
  const skipped = wanted.filter((id) => !queuedIds.has(id));
  const rows = await db
    .select({ status: files.status, deletedAt: files.deletedAt })
    .from(files)
    .where(inArray(files.id, skipped));
  if (rows.some((f) => f.status !== "upload_requested" || f.deletedAt)) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message:
        "Some files changed while the upload was being requested. Check the run and request the upload again.",
    };
  }
  return null;
}

interface UploadPrepError {
  code: "NOT_FOUND" | "CONFLICT" | "WATCHER_OFFLINE";
  message: string;
  ok: false;
  status: number;
}

interface UploadPrepOk {
  ok: true;
  run: NonNullable<Awaited<ReturnType<typeof lookupRunByNaturalKey>>>;
}

export type RequestUploadResult =
  | {
      ok: true;
      instrumentId: string;
      runId: string;
      filesQueued: number;
      files?: Array<{
        id: number;
        filename: string;
        uploadRequestedAt: Date | null;
      }>;
    }
  | {
      ok: false;
      status: number;
      code: "NOT_FOUND" | "CONFLICT" | "WATCHER_OFFLINE" | "VALIDATION_ERROR";
      message: string;
    };

async function prepareUploadTarget(
  instrumentId: string,
  runId: string
): Promise<UploadPrepOk | UploadPrepError> {
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: `Run '${runId}' not found for instrument '${instrumentId}'`,
    };
  }

  if (run.deletedAt) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: DELETED_RUN_MESSAGE,
    };
  }

  // Reject offline early so rows aren't left stuck in `upload_requested`.
  if (!(await instrumentHasOnlineWatcher(run.instrumentId))) {
    return {
      ok: false,
      status: 409,
      code: "WATCHER_OFFLINE",
      message:
        "No online watcher for this instrument. Bring the watcher online before requesting uploads — otherwise nothing will transfer to S3.",
    };
  }

  return { ok: true, run };
}

// Shared by REST `request-upload` and MCP `request_run_upload`. `fileIds` is
// raw caller input; this is the single validation gate and fails closed so a
// garbled batch can't queue a partial set.
export async function requestRunUploads(input: {
  instrumentId: string;
  runId: string;
  fileIds: readonly unknown[];
}): Promise<RequestUploadResult> {
  const prepared = await prepareUploadTarget(input.instrumentId, input.runId);
  if (!prepared.ok) {
    return prepared;
  }

  const { run } = prepared;
  const { fileIds: rawFileIds } = input;

  if (rawFileIds.length === 0) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      message: "file_ids must be a non-empty array",
    };
  }
  if (rawFileIds.length > MAX_UPLOAD_FILE_IDS) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      message: `file_ids cannot exceed ${MAX_UPLOAD_FILE_IDS} entries`,
    };
  }
  if (
    !rawFileIds.every((id) => typeof id === "number" && Number.isInteger(id))
  ) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      message: "file_ids must contain only integer values",
    };
  }
  const fileIds = rawFileIds as number[];

  const requestedFiles = await db
    .select()
    .from(files)
    .where(inArray(files.id, fileIds));

  const requestedById = new Map(requestedFiles.map((f) => [f.id, f]));

  for (const fid of fileIds) {
    const f = requestedById.get(fid);
    if (!f) {
      return {
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        message: `File ${fid} not found`,
      };
    }
    if (f.instrumentRunId !== run.id) {
      return {
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        message: `File ${fid} does not belong to this run`,
      };
    }
    if (f.deletedAt) {
      return {
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        message: `File ${fid} has been deleted`,
      };
    }
    if (f.status !== "detected" && f.status !== "upload_requested") {
      return {
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        message: `File ${fid} is in '${f.status}' status and cannot be queued for upload`,
      };
    }
  }

  const now = new Date();
  const toTransition = fileIds.filter(
    (fid) => requestedById.get(fid)?.status === "detected"
  );

  if (toTransition.length > 0) {
    // The conditions repeat what was checked above, because the run or a file
    // can change in between. A file that is no longer `detected` is left as it
    // is, and a deleted run is left alone.
    const queued = await db
      .update(files)
      .set({ status: "upload_requested", uploadRequestedAt: now })
      .where(
        and(
          inArray(files.id, toTransition),
          eq(files.status, "detected"),
          isNull(files.deletedAt),
          runIsLive(run.id)
        )
      )
      .returning({ id: files.id });
    if (queued.length > 0) {
      await touchRuns([run.id]);
    }
    if (queued.length < toTransition.length) {
      const problem = await explainSkippedFiles(
        run.id,
        toTransition,
        queued.map((f) => f.id)
      );
      if (problem) {
        return problem;
      }
    }
  }

  return {
    ok: true,
    instrumentId: run.instrumentId,
    runId: run.runId,
    filesQueued: fileIds.length,
    files: fileIds.map((fid) => {
      const f = requestedById.get(fid);
      return {
        id: fid,
        filename: f?.filename ?? "",
        uploadRequestedAt:
          f?.status === "upload_requested" ? f.uploadRequestedAt : now,
      };
    }),
  };
}

// Shared by REST `request-upload-all` and MCP `request_run_upload_all`.
export async function requestAllRunUploads(
  instrumentId: string,
  runId: string
): Promise<RequestUploadResult> {
  const prepared = await prepareUploadTarget(instrumentId, runId);
  if (!prepared.ok) {
    return prepared;
  }

  const { run } = prepared;
  const now = new Date();

  const updated = await db
    .update(files)
    .set({ status: "upload_requested", uploadRequestedAt: now })
    .where(
      and(
        eq(files.instrumentRunId, run.id),
        eq(files.status, "detected"),
        isNull(files.deletedAt),
        runIsLive(run.id)
      )
    )
    .returning({ id: files.id });

  if (updated.length > 0) {
    await touchRuns([run.id]);
  } else if (await runWasDeleted(run.id)) {
    // The run was deleted after the check above, so nothing was queued.
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: DELETED_RUN_MESSAGE,
    };
  }

  return {
    ok: true,
    instrumentId: run.instrumentId,
    runId: run.runId,
    filesQueued: updated.length,
  };
}
