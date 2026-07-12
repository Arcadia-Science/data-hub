import { and, eq, inArray, isNull } from "drizzle-orm";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { instrumentHasOnlineWatcher } from "@/lib/api/instruments";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";

export const MAX_UPLOAD_FILE_IDS = 100;

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
      message: "Cannot request uploads for a soft-deleted run",
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

// Shared by REST `request-upload` and MCP `request_run_upload`.
export async function requestRunUploads(input: {
  instrumentId: string;
  runId: string;
  fileIds: number[];
}): Promise<RequestUploadResult> {
  const prepared = await prepareUploadTarget(input.instrumentId, input.runId);
  if (!prepared.ok) {
    return prepared;
  }

  const { run } = prepared;
  const { fileIds } = input;

  if (fileIds.length === 0) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      message: "file_ids must be a non-empty array",
    };
  }
  if (fileIds.length > MAX_UPLOAD_FILE_IDS) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      message: `file_ids cannot exceed ${MAX_UPLOAD_FILE_IDS} entries`,
    };
  }
  if (!fileIds.every((id) => Number.isInteger(id))) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      message: "file_ids must contain only integer values",
    };
  }

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
    await db
      .update(files)
      .set({ status: "upload_requested", uploadRequestedAt: now })
      .where(inArray(files.id, toTransition));
  }

  await db
    .update(instrumentRuns)
    .set({ updatedAt: now })
    .where(eq(instrumentRuns.id, run.id));

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
        isNull(files.deletedAt)
      )
    )
    .returning({ id: files.id });

  if (updated.length > 0) {
    await db
      .update(instrumentRuns)
      .set({ updatedAt: now })
      .where(eq(instrumentRuns.id, run.id));
  }

  return {
    ok: true,
    instrumentId: run.instrumentId,
    runId: run.runId,
    filesQueued: updated.length,
  };
}
