import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { touchRuns } from "@/lib/api/touch-runs";
import { db } from "@/lib/db";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
import { isProcessableInstrumentType } from "@/lib/instruments/processable-types";
import { hasInvokeCredentials, signLambdaInvoke } from "@/lib/lambda";
import { requestWasNotSent } from "@/lib/lambda-invoke-error";
import { processingConcurrencyLimit } from "@/lib/runs/processing-limit";
import { REPROCESSABLE_STATUSES } from "@/lib/runs/reprocessable-statuses";
import {
  isStalledProcessing,
  minutesUntilProcessingIsStalled,
} from "@/lib/runs/stalled-processing";
import {
  inFlightProcessingSql,
  stalledProcessingSql,
} from "@/lib/runs/stalled-processing.sql";

function getLambdaUrl(): string | null {
  const url = process.env.LAMBDA_FUNCTION_URL;
  if (!(url && hasInvokeCredentials())) {
    return null;
  }
  return url;
}

export type ReprocessResult =
  | {
      ok: true;
      fileId: number;
      // `processing` when the file started right away, `queued` when it is
      // waiting for a free slot.
      fileStatus: "processing" | "queued";
    }
  | {
      ok: false;
      status: number;
      code: "NOT_FOUND" | "CONFLICT" | "INTERNAL_ERROR";
      message: string;
      details?: Record<string, unknown>;
    };

type ReprocessFailure = Extract<ReprocessResult, { ok: false }>;

function conflict(message: string): ReprocessFailure {
  return { ok: false, status: 409, code: "CONFLICT", message };
}

function fileNotFound(fileId: number): ReprocessFailure {
  return {
    ok: false,
    status: 404,
    code: "NOT_FOUND",
    message: `File '${fileId}' not found`,
  };
}

// One file with the run and instrument details the checks below need. The run
// fields are null only for a file whose parent run is missing.
interface ReprocessCandidate {
  file: typeof files.$inferSelect;
  instrumentType: typeof instruments.$inferSelect.instrumentType | null;
  runDeletedAt: Date | null;
}

// Why a file cannot be reprocessed, or null when it can. Reads no clock of
// its own: `now` is the one reading the caller uses for the stall check and
// the UPDATE that follows.
function reprocessRejection(
  { file, instrumentType, runDeletedAt }: ReprocessCandidate,
  now: Date
): ReprocessFailure | null {
  if (file.deletedAt) {
    return conflict("Cannot reprocess a soft-deleted file");
  }

  // Processed artifacts often share watcher extensions. Lambda only
  // ingests raw inputs; queuing them marks them processing then strands
  // them when the processor ignores the filename.
  if (file.category !== "raw") {
    return conflict(
      "Cannot reprocess a processed artifact — only raw files can be reprocessed"
    );
  }

  if (file.status === "queued") {
    return conflict("File is already queued for reprocessing");
  }

  const canReprocessStatus =
    (REPROCESSABLE_STATUSES as readonly string[]).includes(file.status) ||
    isStalledProcessing(file, now);
  if (!canReprocessStatus) {
    // Reaching here with `processing` means the file is inside the stall
    // window, which in turn means it has a start timestamp (a null one is
    // always stalled), so there is a real wait to quote.
    if (file.status === "processing" && file.processingStartedAt !== null) {
      const remaining = minutesUntilProcessingIsStalled(
        file.processingStartedAt,
        now
      );
      return conflict(
        `Cannot reprocess a file that is still processing — try again in ${remaining} minute${remaining === 1 ? "" : "s"}`
      );
    }
    return conflict(
      `Cannot reprocess a file in '${file.status}' status — only 'uploaded', 'failed', 'completed', or stalled 'processing' files can be reprocessed`
    );
  }

  if (!(file.s3Bucket && file.s3Key)) {
    return conflict("File has no S3 location — it cannot be reprocessed");
  }

  if (runDeletedAt) {
    return conflict("Cannot reprocess a file whose parent run is soft-deleted");
  }

  if (!(instrumentType && isProcessableInstrumentType(instrumentType))) {
    return conflict(
      instrumentType
        ? `Instrument type '${instrumentType}' has no Lambda processor — cannot reprocess`
        : "Cannot reprocess a file with no parent run"
    );
  }

  return null;
}

// Moves files to `queued` and starts as many as the processing limit allows.
// Shared by the REST routes, the MCP tools, and `reprocessRun`, so every way
// to reprocess goes through the same per-file checks and the same queue.
//
// Loads the files, runs the checks, and moves every eligible file to `queued`
// with one UPDATE. Files that fail a check come back as failures and are left
// alone. Returns one result per distinct file ID.
export async function queueFilesForReprocessing(
  fileIds: readonly number[]
): Promise<Map<number, ReprocessResult>> {
  const ids = [...new Set(fileIds)];
  const results = new Map<number, ReprocessResult>();
  if (ids.length === 0) {
    return results;
  }

  const rows: ReprocessCandidate[] = await db
    .select({
      file: files,
      instrumentType: instruments.instrumentType,
      runDeletedAt: instrumentRuns.deletedAt,
    })
    .from(files)
    .leftJoin(instrumentRuns, eq(instrumentRuns.id, files.instrumentRunId))
    .leftJoin(instruments, eq(instruments.id, instrumentRuns.instrumentId))
    .where(inArray(files.id, ids));
  const candidates = new Map(rows.map((row) => [row.file.id, row]));

  // Checked per file, after the file's own checks, so a file that cannot be
  // reprocessed for another reason still says so when Lambda is not set up.
  const lambdaConfigured = getLambdaUrl() !== null;
  const now = new Date();
  const eligible: ReprocessCandidate[] = [];
  for (const id of ids) {
    const candidate = candidates.get(id);
    if (!candidate) {
      results.set(id, fileNotFound(id));
      continue;
    }
    const rejection = reprocessRejection(candidate, now);
    if (rejection) {
      results.set(id, rejection);
    } else if (lambdaConfigured) {
      eligible.push(candidate);
    } else {
      results.set(id, {
        ok: false,
        status: 503,
        code: "INTERNAL_ERROR",
        message: "Lambda reprocessing is not configured",
      });
    }
  }
  if (eligible.length === 0) {
    return results;
  }

  // The status guard repeats the eligibility check against the rows as they
  // are now, so two requests for the same file cannot both queue it.
  const queued = await db
    .update(files)
    .set({
      status: "queued",
      queuedAt: new Date(),
      processedAt: null,
      errorMessage: null,
      processingStartedAt: null,
    })
    .where(
      and(
        inArray(
          files.id,
          eligible.map((c) => c.file.id)
        ),
        isNull(files.deletedAt),
        or(
          inArray(files.status, [...REPROCESSABLE_STATUSES]),
          stalledProcessingSql(now)
        )
      )
    )
    .returning({ id: files.id, runId: files.instrumentRunId });
  const queuedIds = new Set(queued.map((row) => row.id));
  for (const { file } of eligible) {
    results.set(
      file.id,
      queuedIds.has(file.id)
        ? { ok: true, fileId: file.id, fileStatus: "queued" }
        : conflict("File changed while it was being queued — try again")
    );
  }
  await touchRuns(queued.map((row) => row.runId));

  // The files are saved as queued, so a failure here is not a failed request:
  // the next completed file or the cron starts them.
  let started: number[] = [];
  try {
    started = await dispatchQueuedFiles();
  } catch (err) {
    console.error("Failed to start queued files after queuing:", err);
  }
  for (const id of started) {
    if (queuedIds.has(id)) {
      results.set(id, { ok: true, fileId: id, fileStatus: "processing" });
    }
  }

  return results;
}

// Shared core for single-file reprocessing, used by both the REST route
// (/api/v1/files/:fileId/reprocess) and the MCP `reprocess_file` tool. The
// file is queued and then starts as soon as fewer than the processing limit
// are in flight. Stalled processing files are eligible; in-flight ones are not.
export async function reprocessFile(fileId: number): Promise<ReprocessResult> {
  const results = await queueFilesForReprocessing([fileId]);
  return results.get(fileId) ?? fileNotFound(fileId);
}

export type ReprocessRunResult =
  | {
      ok: true;
      instrumentId: string;
      runId: string;
      // Files accepted: queued, or started right away when there was room.
      filesQueued: number;
      filesFailed: number;
    }
  | {
      ok: false;
      status: number;
      code: "NOT_FOUND" | "CONFLICT";
      message: string;
    };

// Queues the run's eligible files together through `queueFilesForReprocessing`
// so REST and MCP share the same per-file checks.
export async function reprocessRun(
  instrumentId: string,
  runId: string
): Promise<ReprocessRunResult> {
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
      message: "Cannot reprocess a soft-deleted run",
    };
  }

  if (!isProcessableInstrumentType(run.instrumentType)) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `Instrument type '${run.instrumentType}' has no Lambda processor — cannot reprocess`,
    };
  }

  const eligible = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.instrumentRunId, run.id),
        eq(files.category, "raw"),
        isNull(files.deletedAt),
        or(
          inArray(files.status, [...REPROCESSABLE_STATUSES]),
          stalledProcessingSql()
        )
      )
    );

  if (eligible.length === 0) {
    return {
      ok: true,
      instrumentId: run.instrumentId,
      runId: run.runId,
      filesQueued: 0,
      filesFailed: 0,
    };
  }

  const results = await queueFilesForReprocessing(eligible.map((f) => f.id));
  const filesQueued = [...results.values()].filter((r) => r.ok).length;

  return {
    ok: true,
    instrumentId: run.instrumentId,
    runId: run.runId,
    filesQueued,
    filesFailed: results.size - filesQueued,
  };
}

// Held for the length of one dispatch transaction, so two dispatchers never
// count the same free slots and start more files than the limit allows.
// `pg_advisory_xact_lock` waits for the lock instead of giving up. The next
// dispatcher counts the files in flight after the one before it has committed,
// so every request that queued a file helps start the queue.
export const DISPATCH_LOCK_NAME = "data-hub:reprocess-queue-dispatch";

// The longest a dispatcher waits for that lock, and for any other lock inside
// its transaction. The holder keeps the lock for a few short queries, so a wait
// this long means something is wrong. The dispatcher then gives up and the
// reprocess-queue cron starts the files on its next run.
const DISPATCH_LOCK_TIMEOUT = "5s";

// The SQLSTATE that Postgres raises when `lock_timeout` runs out.
const LOCK_NOT_AVAILABLE = "55P03";

// `pg` puts the SQLSTATE on `code`. Drizzle wraps the `pg` error as the
// `cause` of its own, so look down the chain.
function hasPgErrorCode(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    const { code: found, cause } = current as {
      code?: unknown;
      cause?: unknown;
    };
    if (found === code) {
      return true;
    }
    current = cause;
  }
  return false;
}

interface StartedFile {
  id: number;
  // When the file was queued. A start that the Lambda throttles puts the file
  // back in this place in line.
  queuedAt: Date | null;
  s3Bucket: string;
  s3Key: string;
  // The `processing_started_at` that this dispatch wrote. An update that
  // matches it only touches the file while that start is still the current one.
  startedAt: Date;
}

// The queued files that the dispatcher may start. Deleted files and files in
// deleted runs are left queued: if the run is restored, they start then. A
// file with no S3 location cannot be invoked. Both queries that read the queue
// use this, joined to `instrument_runs`, so the cheap check and the real
// selection agree on what counts.
function startableQueuedFileSql() {
  return and(
    eq(files.status, "queued"),
    isNull(files.deletedAt),
    isNull(instrumentRuns.deletedAt),
    isNotNull(files.s3Bucket),
    isNotNull(files.s3Key)
  );
}

// The cheap check that runs before every dispatch. Almost every dispatch finds
// nothing to start (each completed file triggers one), and one indexed read
// answers that without opening a transaction. Files that cannot start stay
// queued, so this check skips them too. If it counted them, every dispatch
// would open a transaction for nothing.
export async function hasStartableQueuedFiles(): Promise<boolean> {
  const [anyStartable] = await db
    .select({ id: files.id })
    .from(files)
    .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
    .where(startableQueuedFileSql())
    .limit(1);
  return anyStartable !== undefined;
}

// Moves the oldest queued files to `processing`, as many as there is room
// for, and returns them. The caller invokes the Lambda after the commit.
async function claimQueuedFiles(): Promise<StartedFile[]> {
  if (!(await hasStartableQueuedFiles())) {
    return [];
  }

  try {
    return await db.transaction(async (tx) => {
      // The timeout covers the lock wait below and any row lock the updates
      // wait on. `SET LOCAL` ends with the transaction.
      await tx.execute(
        sql`set local lock_timeout = ${sql.raw(`'${DISPATCH_LOCK_TIMEOUT}'`)}`
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${DISPATCH_LOCK_NAME}))`
      );

      // Counted after the lock is held, so a dispatcher that waited sees the
      // files the one before it started. Stalled files do not count: their
      // processor is gone, so a new file may take the slot.
      const now = new Date();
      const [{ inFlight }] = await tx
        .select({ inFlight: sql<number>`cast(count(*) as int)` })
        .from(files)
        .where(
          and(
            eq(files.category, "raw"),
            isNull(files.deletedAt),
            inFlightProcessingSql(now)
          )
        );
      const room = processingConcurrencyLimit() - inFlight;
      if (room <= 0) {
        return [];
      }

      const next = await tx
        .select({ id: files.id, queuedAt: files.queuedAt })
        .from(files)
        .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
        .where(startableQueuedFileSql())
        .orderBy(asc(files.queuedAt), asc(files.id))
        .limit(room);
      if (next.length === 0) {
        return [];
      }
      const queuedAtById = new Map(next.map((f) => [f.id, f.queuedAt]));

      const started = await tx
        .update(files)
        .set({ status: "processing", processingStartedAt: now, queuedAt: null })
        .where(
          and(
            inArray(
              files.id,
              next.map((f) => f.id)
            ),
            eq(files.status, "queued"),
            isNull(files.deletedAt)
          )
        )
        .returning({
          id: files.id,
          s3Bucket: files.s3Bucket,
          s3Key: files.s3Key,
          startedAt: files.processingStartedAt,
          runId: files.instrumentRunId,
        });
      await touchRuns(
        started.map((f) => f.runId),
        tx
      );

      return started.flatMap((f) =>
        f.s3Bucket && f.s3Key && f.startedAt
          ? [
              {
                id: f.id,
                queuedAt: queuedAtById.get(f.id) ?? null,
                s3Bucket: f.s3Bucket,
                s3Key: f.s3Key,
                startedAt: f.startedAt,
              },
            ]
          : []
      );
    });
  } catch (err) {
    // Another dispatcher held the lock for the whole timeout. The files stay
    // queued, and the cron starts them on its next run.
    if (hasPgErrorCode(err, LOCK_NOT_AVAILABLE)) {
      console.warn(
        `Gave up waiting ${DISPATCH_LOCK_TIMEOUT} for the reprocess queue lock; the cron will start the queued files.`
      );
      return [];
    }
    throw err;
  }
}

// Starts queued files while fewer than the processing limit are in flight,
// and returns the IDs it started. Runs after every reprocess request, after
// every file that completes or fails, after an invocation that ended without
// a result, and from the reprocess-queue cron.
//
// Does nothing when Lambda is not configured, because files marked
// `processing` with no invocation would only wait out the stall window.
export async function dispatchQueuedFiles(): Promise<number[]> {
  const lambdaUrl = getLambdaUrl();
  if (!lambdaUrl) {
    return [];
  }

  const started = await claimQueuedFiles();
  if (started.length === 0) {
    return [];
  }

  // The Function URL is BUFFERED, so its response arrives only when the
  // invocation has ended. Awaiting it here would hold this request open for
  // the whole run. `after` sends the invocation once the response is out. The
  // Lambda reports its own result with PATCH /api/v1/files/:fileId, and this
  // callback only reads the HTTP response.
  //
  // The callback lives only as long as the route's `maxDuration` (60 s on
  // /mcp/v1). A run that outlasts it ends the callback before the Lambda
  // answers, so nothing reads that response and a failure after that point is
  // never seen here. The file then stays `processing` until it stalls, and the
  // reprocess-queue cron takes its slot after that.
  after(async () => {
    await Promise.all(
      started.map((file) => invokeLambdaForFile(lambdaUrl, file))
    );
  });

  return started.map((f) => f.id);
}

const NOT_STARTED_MESSAGE =
  "Processing could not start: Data Hub could not send the request to the Lambda. Reprocess the file to try again.";

function noResultMessage(httpStatus: number): string {
  return `Processing ended without a result: the Lambda returned HTTP ${httpStatus}. Reprocess the file to try again.`;
}

// What happens to a started file depends on what the invocation tells us:
//   - A response with an error status: with a BUFFERED Function URL, a response
//     means the invocation has ended. The file goes to `failed`, and its slot
//     goes to the next queued file. A 429 means the Lambda was throttled and
//     did not start, so the file goes back to `queued` and the cron retries it.
//   - A failure to sign or to connect: the request never left, so the file
//     goes to `failed` the same way.
//   - A timeout, abort, or reset after the request was sent: nothing is known,
//     and the Lambda may still be running. The file is left alone.
async function invokeLambdaForFile(
  lambdaUrl: string,
  file: StartedFile
): Promise<void> {
  // Build a synthetic S3 event matching the shape parse_s3_event expects.
  // Real S3 events use application/x-www-form-urlencoded encoding for the
  // object key: "+" → "%2B", spaces → "+", and "/" stays literal.
  // encodeURIComponent gets most of the way there ("%2B" for "+", "%20"
  // for space, "%2F" for "/"), and we restore literal "/" to match S3's
  // format. The Lambda decodes with urllib.parse.unquote_plus, which
  // turns both "+" and "%20" back into a space, so this payload
  // round-trips identically to a real S3 event notification.
  const s3Event = {
    Records: [
      {
        s3: {
          bucket: { name: file.s3Bucket },
          object: {
            key: encodeURIComponent(file.s3Key).replaceAll("%2F", "/"),
          },
        },
      },
    ],
  };

  let signed: Request;
  try {
    signed = await signLambdaInvoke({
      url: lambdaUrl,
      body: JSON.stringify(s3Event),
    });
  } catch (err) {
    console.error(
      `Failed to sign the Lambda request for file ${file.id}:`,
      err
    );
    await failStartedFile(file, NOT_STARTED_MESSAGE);
    return;
  }

  let res: Response;
  try {
    res = await fetch(signed);
  } catch (err) {
    if (requestWasNotSent(err)) {
      console.error(
        `Could not connect to the Lambda for file ${file.id}:`,
        err
      );
      await failStartedFile(file, NOT_STARTED_MESSAGE);
      return;
    }
    console.error(
      `Lost the connection to the Lambda for file ${file.id}. The Lambda may still be running, so the file stays in processing:`,
      err
    );
    return;
  }

  if (res.ok) {
    return;
  }
  console.error(
    `Lambda returned ${res.status} for file ${file.id}:`,
    await res.text().catch(() => "")
  );
  if (res.status === 429) {
    await requeueStartedFile(file);
    return;
  }
  await failStartedFile(file, noResultMessage(res.status));
}

// Both updates below match the status and the exact `processing_started_at`
// that the dispatch wrote. If the Lambda has already written a final status,
// or a newer start has replaced this one, nothing matches and the file is left
// as it is.
function stillThisStart(file: StartedFile) {
  return and(
    eq(files.id, file.id),
    eq(files.status, "processing"),
    eq(files.processingStartedAt, file.startedAt)
  );
}

// Marks a file `failed` because its invocation ended without a result, then
// lets the next queued file use the slot. `processed_at` is set the way a
// failure reported by the Lambda sets it.
async function failStartedFile(
  file: StartedFile,
  message: string
): Promise<void> {
  try {
    const [updated] = await db
      .update(files)
      .set({ status: "failed", processedAt: new Date(), errorMessage: message })
      .where(stillThisStart(file))
      .returning({ runId: files.instrumentRunId });
    if (!updated) {
      return;
    }
    await touchRuns([updated.runId]);
  } catch (err) {
    console.error(`Failed to mark file ${file.id} as failed:`, err);
    return;
  }

  try {
    await dispatchQueuedFiles();
  } catch (err) {
    console.error("Failed to start queued files after a failed start:", err);
  }
}

// Puts a throttled file back in the queue, in the place it had. It does not
// start the next file. The Lambda has no room, so the cron tries again later.
async function requeueStartedFile(file: StartedFile): Promise<void> {
  try {
    const [updated] = await db
      .update(files)
      .set({
        status: "queued",
        queuedAt: file.queuedAt ?? new Date(),
        processingStartedAt: null,
      })
      .where(stillThisStart(file))
      .returning({ runId: files.instrumentRunId });
    if (updated) {
      await touchRuns([updated.runId]);
    }
  } catch (err) {
    console.error(`Failed to put file ${file.id} back in the queue:`, err);
  }
}
