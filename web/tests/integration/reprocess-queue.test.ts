import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DISPATCH_LOCK_NAME,
  hasStartableQueuedFiles,
  requeueStalledDispatches,
} from "@/lib/api/file-reprocessing";
import {
  fileReprocessed,
  runListResponse,
  runQueuedCancelled,
  runReprocessed,
} from "@/lib/api/openapi";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
import { isStalledProcessing } from "@/lib/runs/stalled-processing";
import {
  api,
  clearLambdaInvocations,
  closeTestDb,
  getTestDb,
  lambdaApi,
  readServerLogSince,
  resetDb,
  seedSessionCookie,
  seedTestUser,
  serverLogSize,
  setLambdaResponse,
  settleLambdaInvocations,
  waitForLambdaInvocations,
  waitForLambdaQuiet,
} from "@/tests/integration/helpers";

// Reprocessing queues files, and a dispatcher starts a queued file only while
// fewer than 10 raw files are processing across Data Hub. These tests drive
// the real routes on the server that has a Lambda Function URL configured,
// pointed at a stub that records each invocation (see `lambdaApi` in
// helpers.ts). Files are seeded straight into the database so a run can hold
// more files than the limit.
//
// A dispatch sends its Lambda calls after the response, so a test can end
// before they land. The `afterEach` below waits for the stub to go quiet, so
// the next test does not clear the stub's record while a call is on its way.

// Must match CRON_SECRET set on the test server in global-setup.ts.
const CRON_SECRET = "test-cron-secret";
const LIMIT = 10;

const instrumentId = "queue-test-fplc";

type FileStatus = (typeof files.$inferSelect)["status"];

const MINUTE_MS = 60 * 1000;

let token: string;

// `extra` is added to every file row, for columns the status alone does not
// set, such as `dispatchId` or `stallRequeues`.
async function seedRun(
  runId: string,
  count: number,
  status: FileStatus = "uploaded",
  extra: Partial<typeof files.$inferInsert> = {}
): Promise<{ fileIds: number[]; runInternalId: string }> {
  const db = getTestDb();
  const [run] = await db
    .insert(instrumentRuns)
    .values({ instrumentId, runId, source: "lambda" })
    .returning({ id: instrumentRuns.id });
  const rows = await db
    .insert(files)
    .values(
      Array.from({ length: count }, (_, i) => {
        const filename = `file-${String(i).padStart(3, "0")}.csv`;
        return {
          instrumentRunId: run.id,
          filename,
          relativePath: filename,
          s3Bucket: "test-bucket",
          s3Key: `${instrumentId}/${runId}/${filename}`,
          category: "raw" as const,
          status,
          // Matches a file that was already processing when it was seeded.
          processingStartedAt:
            status === "processing" ? new Date(Date.now() - MINUTE_MS) : null,
          queuedAt: status === "queued" ? new Date() : null,
          ...extra,
        };
      })
    )
    .returning({ id: files.id });
  // `returning` follows insert order, and ids are assigned in that order.
  return { runInternalId: run.id, fileIds: rows.map((r) => r.id) };
}

async function fileRows(ids: number[]) {
  const rows = await getTestDb()
    .select()
    .from(files)
    .where(inArray(files.id, ids));
  return rows.sort((a, b) => a.id - b.id);
}

async function idsWithStatus(ids: number[], status: FileStatus) {
  return (await fileRows(ids))
    .filter((r) => r.status === status)
    .map((r) => r.id);
}

// Stands in for a Lambda that finished and called back, without the PATCH, so
// a test can open a slot without triggering the dispatch that PATCH does.
async function finishFiles(ids: number[]) {
  await getTestDb()
    .update(files)
    .set({ status: "completed", processedAt: new Date() })
    .where(inArray(files.id, ids));
}

function reprocessRunRequest(runId: string) {
  return lambdaApi(
    `/api/v1/instruments/${instrumentId}/runs/${runId}/reprocess`,
    { method: "POST", token }
  );
}

function reprocessFileRequest(fileId: number) {
  return lambdaApi(`/api/v1/files/${fileId}/reprocess`, {
    method: "POST",
    token,
  });
}

function patchFileRequest(fileId: number, status: string) {
  return lambdaApi(`/api/v1/files/${fileId}`, {
    method: "PATCH",
    token,
    body: { status },
  });
}

// Moves a file's start back in time, as if its processing began that long ago.
async function startedMinutesAgo(ids: number[], minutes: number) {
  await getTestDb()
    .update(files)
    .set({ processingStartedAt: new Date(Date.now() - minutes * MINUTE_MS) })
    .where(inArray(files.id, ids));
}

function runCron(secret?: string) {
  return lambdaApi("/api/cron/reprocess-queue", {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  });
}

describe("Reprocess queue", () => {
  beforeEach(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
    await getTestDb().insert(instruments).values({
      id: instrumentId,
      displayName: "Queue Test FPLC",
      status: "active",
      instrumentType: "fplc",
    });
    await clearLambdaInvocations();
  });

  afterEach(async () => {
    await waitForLambdaQuiet();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Reprocessing a run
  // -------------------------------------------------------------------------

  describe("reprocessing a run", () => {
    it("starts 10 files and queues the rest of a 15-file run", async () => {
      const { fileIds } = await seedRun("big-run", 15);

      const res = await reprocessRunRequest("big-run");
      expect(res.status).toBe(200);
      const data = runReprocessed.parse(await res.json());
      // `files_queued` counts every accepted file, started or waiting.
      expect(data.files_queued).toBe(15);
      expect(data.files_failed).toBe(0);

      const invocations = await waitForLambdaInvocations(LIMIT);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);

      const rows = await fileRows(fileIds);
      const processing = rows.filter((r) => r.status === "processing");
      const queued = rows.filter((r) => r.status === "queued");
      expect(processing).toHaveLength(LIMIT);
      expect(queued).toHaveLength(5);
      // Every file in the run was queued in one UPDATE, so the order falls
      // back to the file ID: the first ten start.
      expect(processing.map((r) => r.id)).toEqual(fileIds.slice(0, LIMIT));
      // Each started file got exactly one Lambda invocation, for its S3 key.
      expect(invocations.map((i) => i.key).sort()).toEqual(
        processing.map((r) => r.s3Key).sort()
      );
      for (const r of processing) {
        expect(r.processingStartedAt).not.toBeNull();
        expect(r.queuedAt).toBeNull();
        expect(r.dispatchId).not.toBeNull();
      }
      // Each start gets its own dispatch ID.
      expect(new Set(processing.map((r) => r.dispatchId)).size).toBe(LIMIT);
      for (const r of queued) {
        expect(r.queuedAt).not.toBeNull();
        expect(r.processingStartedAt).toBeNull();
        expect(r.errorMessage).toBeNull();
        expect(r.dispatchId).toBeNull();
      }

      // The run reads as Queued, with the file counts to match.
      const listRes = await api(
        `/api/v1/instrument-runs?instrument_id=${instrumentId}&status=queued`,
        { token }
      );
      expect(listRes.status).toBe(200);
      const list = runListResponse.parse(await listRes.json());
      expect(list.data).toHaveLength(1);
      expect(list.data[0].run_id).toBe("big-run");
      expect(list.data[0].files_queued).toBe(5);
      expect(list.data[0].files_processing).toBe(LIMIT);
    });

    it("clears the old result when a file is queued", async () => {
      const { fileIds } = await seedRun("rerun", 12, "failed");
      await getTestDb()
        .update(files)
        .set({ errorMessage: "old failure", processedAt: new Date() })
        .where(inArray(files.id, fileIds));

      await reprocessRunRequest("rerun");
      await waitForLambdaInvocations(LIMIT);

      const queued = (await fileRows(fileIds)).filter(
        (r) => r.status === "queued"
      );
      expect(queued).toHaveLength(2);
      for (const r of queued) {
        expect(r.errorMessage).toBeNull();
        expect(r.processedAt).toBeNull();
      }
    });

    it("starts the oldest queued files first, across runs", async () => {
      const a = await seedRun("older-run", 12);
      const b = await seedRun("newer-run", 3);

      await reprocessRunRequest("older-run");
      await waitForLambdaInvocations(LIMIT);
      // The limit is reached, so the newer run's files all wait.
      const bRes = await reprocessRunRequest("newer-run");
      expect(runReprocessed.parse(await bRes.json()).files_queued).toBe(3);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);

      // Three slots open: the older run's two waiting files go first.
      await finishFiles(a.fileIds.slice(0, 3));
      const cron = await runCron(CRON_SECRET);
      expect(await cron.json()).toEqual({ started_files: 3 });
      await waitForLambdaInvocations(LIMIT + 3);

      expect(await idsWithStatus(a.fileIds, "queued")).toEqual([]);
      expect(await idsWithStatus(b.fileIds, "processing")).toEqual([
        b.fileIds[0],
      ]);
      expect(await idsWithStatus(b.fileIds, "queued")).toEqual(
        b.fileIds.slice(1)
      );
    });

    it("skips files that are queued or still processing", async () => {
      const { fileIds } = await seedRun("twice", 15);
      await reprocessRunRequest("twice");
      await waitForLambdaInvocations(LIMIT);

      const again = await reprocessRunRequest("twice");
      expect(again.status).toBe(200);
      const data = runReprocessed.parse(await again.json());
      expect(data.files_queued).toBe(0);
      expect(data.files_failed).toBe(0);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);
      expect(await idsWithStatus(fileIds, "queued")).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  // Reprocessing one file
  // -------------------------------------------------------------------------

  describe("reprocessing a file", () => {
    it("answers processing while there is room and queued once there is not", async () => {
      const { fileIds } = await seedRun("one-by-one", LIMIT + 1);

      const answers: string[] = [];
      for (const id of fileIds) {
        const res = await reprocessFileRequest(id);
        expect(res.status).toBe(200);
        const body = fileReprocessed.parse(await res.json());
        expect(body.file_id).toBe(id);
        answers.push(body.status);
      }

      expect(answers).toEqual([
        ...Array.from({ length: LIMIT }, () => "processing"),
        "queued",
      ]);
      await waitForLambdaInvocations(LIMIT);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);
    });

    it("counts files that started another way toward the limit", async () => {
      // Files a watcher upload started directly are processing too.
      await seedRun("watcher-started", LIMIT, "processing");
      const { fileIds } = await seedRun("waits", 1);

      const res = await reprocessFileRequest(fileIds[0]);
      expect(res.status).toBe(200);
      expect(fileReprocessed.parse(await res.json()).status).toBe("queued");
      expect(await settleLambdaInvocations()).toHaveLength(0);
    });

    it("returns 409 for a file that is already queued", async () => {
      const { fileIds } = await seedRun("requeue", LIMIT + 1);
      await reprocessRunRequest("requeue");
      await waitForLambdaInvocations(LIMIT);
      const [queuedId] = await idsWithStatus(fileIds, "queued");
      const [before] = await fileRows([queuedId]);

      const res = await reprocessFileRequest(queuedId);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error.message).toBe(
        "File is already queued for reprocessing"
      );

      const [after] = await fileRows([queuedId]);
      expect(after.status).toBe("queued");
      expect(after.queuedAt?.getTime()).toBe(before.queuedAt?.getTime());
    });

    it("queues a file once when two requests arrive together", async () => {
      const { fileIds } = await seedRun("double-click", 1, "completed");

      const responses = await Promise.all([
        reprocessFileRequest(fileIds[0]),
        reprocessFileRequest(fileIds[0]),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      await waitForLambdaInvocations(1);
      expect(await settleLambdaInvocations()).toHaveLength(1);
    });

    it("starts exactly the limit when many requests arrive together", async () => {
      const { fileIds } = await seedRun("burst", 25);

      const responses = await Promise.all(
        fileIds.map((id) => reprocessFileRequest(id))
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);

      // A dispatcher waits for the lock and counts the files in flight after
      // the one before it has committed, so the burst never starts more than
      // the limit. It also never starts fewer: the request whose file was
      // queued last dispatches after every file is queued, and by then it sees
      // all 25 and fills the slots that are left. The dispatches that came
      // before it started fewer files, but their count adds up to the limit.
      await waitForLambdaInvocations(LIMIT);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);
      expect(await idsWithStatus(fileIds, "processing")).toHaveLength(LIMIT);
      expect(await idsWithStatus(fileIds, "queued")).toHaveLength(15);

      // The cron has nothing to add.
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // What starts the next queued file
  // -------------------------------------------------------------------------

  describe("starting queued files", () => {
    it("starts the next queued file when a file completes or fails", async () => {
      const { fileIds } = await seedRun("chain", 15);
      await reprocessRunRequest("chain");
      await waitForLambdaInvocations(LIMIT);

      expect((await patchFileRequest(fileIds[0], "completed")).status).toBe(
        200
      );
      await waitForLambdaInvocations(LIMIT + 1);
      expect(await idsWithStatus(fileIds, "processing")).toEqual([
        ...fileIds.slice(1, LIMIT + 1),
      ]);

      expect((await patchFileRequest(fileIds[1], "failed")).status).toBe(200);
      await waitForLambdaInvocations(LIMIT + 2);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT + 2);
      expect(await idsWithStatus(fileIds, "queued")).toEqual(
        fileIds.slice(LIMIT + 2)
      );
    });

    it("does not start a queued file for a PATCH that does not finish a file", async () => {
      const { fileIds } = await seedRun("quiet", 12);
      await reprocessRunRequest("quiet");
      await waitForLambdaInvocations(LIMIT);
      // A slot is open, but nothing has asked the dispatcher to look.
      await finishFiles([fileIds[0]]);

      const res = await lambdaApi(`/api/v1/files/${fileIds[1]}`, {
        method: "PATCH",
        token,
        body: { metadata: { note: "still running" } },
      });
      expect(res.status).toBe(200);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);
    });

    it("starts queued files from the cron once there is room, and needs CRON_SECRET", async () => {
      const { fileIds } = await seedRun("cron-run", 12);
      await reprocessRunRequest("cron-run");
      await waitForLambdaInvocations(LIMIT);
      await finishFiles([fileIds[0]]);

      expect((await runCron()).status).toBe(401);
      expect((await runCron("wrong-secret")).status).toBe(401);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);

      const res = await runCron(CRON_SECRET);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ started_files: 1 });
      await waitForLambdaInvocations(LIMIT + 1);

      // Full again: one file is still queued, and a second run starts none.
      const second = await runCron(CRON_SECRET);
      expect(await second.json()).toEqual({ started_files: 0 });
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT + 1);
      expect(await idsWithStatus(fileIds, "queued")).toEqual([fileIds[11]]);
    });

    it("lets a stalled file give up its slot", async () => {
      const { fileIds } = await seedRun("stall", 12);
      await reprocessRunRequest("stall");
      await waitForLambdaInvocations(LIMIT);
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 0,
      });

      // One processing file started 21 minutes ago and never reported back.
      // An S3 upload started it, so it has no dispatch ID, and the cron does
      // not put it back in the queue (see "a stalled start that the dispatcher
      // made" for the files it does put back).
      await getTestDb()
        .update(files)
        .set({
          processingStartedAt: new Date(Date.now() - 21 * MINUTE_MS),
          dispatchId: null,
        })
        .where(eq(files.id, fileIds[0]));

      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 1,
      });
      await waitForLambdaInvocations(LIMIT + 1);
      // The stalled file is left as it was, and only one queued file started.
      expect((await fileRows([fileIds[0]]))[0].status).toBe("processing");
      expect(await idsWithStatus(fileIds, "queued")).toEqual([fileIds[11]]);
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 0,
      });
    });

    it("skips deleted files, files in deleted runs, and files with no S3 key", async () => {
      const a = await seedRun("skip-a", LIMIT + 3);
      await reprocessRunRequest("skip-a");
      await waitForLambdaInvocations(LIMIT);
      const [deletedFile, waiting, noKey] = a.fileIds.slice(LIMIT);

      const b = await seedRun("skip-b", 1);
      await reprocessRunRequest("skip-b");
      expect(await idsWithStatus(b.fileIds, "queued")).toHaveLength(1);

      const db = getTestDb();
      await db
        .update(files)
        .set({ deletedAt: new Date() })
        .where(eq(files.id, deletedFile));
      await db
        .update(files)
        .set({ s3Bucket: null, s3Key: null })
        .where(eq(files.id, noKey));
      await db
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, b.runInternalId));

      // Plenty of room, and four files waiting.
      await finishFiles(a.fileIds.slice(0, LIMIT));
      const res = await runCron(CRON_SECRET);
      expect(await res.json()).toEqual({ started_files: 1 });
      await waitForLambdaInvocations(LIMIT + 1);
      expect(
        await idsWithStatus([...a.fileIds, ...b.fileIds], "queued")
      ).toEqual([deletedFile, noKey, ...b.fileIds].sort((x, y) => x - y));
      expect(await idsWithStatus(a.fileIds, "processing")).toEqual([waiting]);

      // Restoring the run puts its file back in line.
      await db
        .update(instrumentRuns)
        .set({ deletedAt: null })
        .where(eq(instrumentRuns.id, b.runInternalId));
      const restored = await runCron(CRON_SECRET);
      expect(await restored.json()).toEqual({ started_files: 1 });
      expect(await idsWithStatus(b.fileIds, "processing")).toEqual(b.fileIds);
      // The restored run's file is invoked too.
      const invocations = await waitForLambdaInvocations(LIMIT + 2);
      expect(invocations.map((i) => i.key)).toContain(
        `${instrumentId}/skip-b/file-000.csv`
      );
    });

    it("does not count queued files that cannot start", async () => {
      const a = await seedRun("cannot-start-a", 2, "queued");
      const b = await seedRun("cannot-start-b", 1, "queued");
      expect(await hasStartableQueuedFiles()).toBe(true);

      const db = getTestDb();
      // A deleted file, a file with no S3 location, and a file in a deleted
      // run: none of them can start.
      await db
        .update(files)
        .set({ deletedAt: new Date() })
        .where(eq(files.id, a.fileIds[0]));
      await db
        .update(files)
        .set({ s3Bucket: null, s3Key: null })
        .where(eq(files.id, a.fileIds[1]));
      expect(await hasStartableQueuedFiles()).toBe(true);
      await db
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, b.runInternalId));
      expect(await hasStartableQueuedFiles()).toBe(false);

      // They stay queued, and a restored run is back in line.
      expect(
        await idsWithStatus([...a.fileIds, ...b.fileIds], "queued")
      ).toHaveLength(3);
      await db
        .update(instrumentRuns)
        .set({ deletedAt: null })
        .where(eq(instrumentRuns.id, b.runInternalId));
      expect(await hasStartableQueuedFiles()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // An invocation that does not run the file
  // -------------------------------------------------------------------------

  describe("when the Lambda does not run a file", () => {
    // The seeded files are named file-000.csv, file-001.csv, and so on.
    const keyOf = (runId: string, index: number) =>
      `${instrumentId}/${runId}/file-${String(index).padStart(3, "0")}.csv`;

    it.each([
      502, 403,
    ])("marks the file failed when the Lambda answers HTTP %i, and starts the next queued file", async (httpStatus) => {
      const runId = `answers-${httpStatus}`;
      const { fileIds } = await seedRun(runId, LIMIT + 2);
      await setLambdaResponse(keyOf(runId, 0), { status: httpStatus });

      await reprocessRunRequest(runId);

      // Ten files start, the first one fails, and its slot goes to the
      // eleventh file, which makes eleven invocations.
      await waitForLambdaInvocations(LIMIT + 1);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT + 1);

      const [failed] = await fileRows(fileIds);
      expect(failed.status).toBe("failed");
      expect(failed.errorMessage).toBe(
        `Processing ended without a result: the Lambda returned HTTP ${httpStatus}. Reprocess the file to try again.`
      );
      expect(failed.processedAt).not.toBeNull();
      expect(failed.queuedAt).toBeNull();
      expect(failed.dispatchId).toBeNull();
      expect(await idsWithStatus(fileIds, "processing")).toEqual(
        fileIds.slice(1, LIMIT + 1)
      );
      expect(await idsWithStatus(fileIds, "queued")).toEqual([
        fileIds[LIMIT + 1],
      ]);
    });

    it("puts a file back in the queue when the Lambda is throttled, and leaves the next start to the cron", async () => {
      const runId = "throttled";
      const { fileIds } = await seedRun(runId, LIMIT + 1);
      await setLambdaResponse(keyOf(runId, 0), { status: 429 });

      await reprocessRunRequest(runId);

      // Nothing starts in the place of the throttled file.
      await waitForLambdaInvocations(LIMIT);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);
      const rows = await fileRows(fileIds);
      expect(rows[0].status).toBe("queued");
      expect(rows[0].processingStartedAt).toBeNull();
      expect(rows[0].errorMessage).toBeNull();
      expect(rows[0].dispatchId).toBeNull();
      // It keeps its place in line: the time it was first queued.
      expect(rows[0].queuedAt?.getTime()).toBe(rows[LIMIT].queuedAt?.getTime());
      expect(await idsWithStatus(fileIds, "processing")).toEqual(
        fileIds.slice(1, LIMIT)
      );

      // The Lambda has room again. The cron starts the throttled file before
      // the one that waited behind it.
      await setLambdaResponse(keyOf(runId, 0), { status: 200 });
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 1,
      });
      const invocations = await waitForLambdaInvocations(LIMIT + 1);
      expect(invocations.at(-1)?.key).toBe(keyOf(runId, 0));
      expect(await idsWithStatus(fileIds, "queued")).toEqual([fileIds[LIMIT]]);
    });

    it("leaves a file in processing when the connection drops after the request was sent", async () => {
      const runId = "dropped";
      const { fileIds } = await seedRun(runId, LIMIT + 1);
      await setLambdaResponse(keyOf(runId, 0), { reset: true });

      await reprocessRunRequest(runId);

      // The Lambda may still be running, so nothing changes and no other file
      // takes the slot.
      await waitForLambdaInvocations(LIMIT);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);
      const [first] = await fileRows(fileIds);
      expect(first.status).toBe("processing");
      expect(first.errorMessage).toBeNull();
      expect(await idsWithStatus(fileIds, "queued")).toEqual([fileIds[LIMIT]]);
    });

    it("does not overwrite a final status that the Lambda already wrote", async () => {
      const runId = "already-done";
      const { fileIds } = await seedRun(runId, 1);
      await setLambdaResponse(keyOf(runId, 0), { status: 502, delayMs: 800 });

      await reprocessRunRequest(runId);
      await waitForLambdaInvocations(1);
      // The Lambda reports its result, and then its response arrives as an
      // error.
      expect((await patchFileRequest(fileIds[0], "completed")).status).toBe(
        200
      );
      await settleLambdaInvocations(1200);

      const [row] = await fileRows(fileIds);
      expect(row.status).toBe("completed");
      expect(row.errorMessage).toBeNull();
    });

    it("does not fail a start that a newer dispatch has replaced", async () => {
      const runId = "restarted";
      const { fileIds } = await seedRun(runId, 1);
      await setLambdaResponse(keyOf(runId, 0), { status: 502, delayMs: 800 });

      await reprocessRunRequest(runId);
      await waitForLambdaInvocations(1);
      // Another dispatch started the same file and gave its start its own ID.
      const newerDispatchId = randomUUID();
      await getTestDb()
        .update(files)
        .set({ dispatchId: newerDispatchId })
        .where(eq(files.id, fileIds[0]));
      await settleLambdaInvocations(1200);

      const [row] = await fileRows(fileIds);
      expect(row.status).toBe("processing");
      expect(row.errorMessage).toBeNull();
      expect(row.dispatchId).toBe(newerDispatchId);
    });

    it("fails a start whose Lambda reported processing and then crashed, and starts the next queued file", async () => {
      // Every processor sends `PATCH status: "processing"` as its first step.
      // That update moves `processing_started_at`, so a guard that compares
      // the timestamp stops matching and the file holds its slot until it
      // stalls. The dispatch ID is not touched by that update.
      const runId = "crashed-after-start";
      const { fileIds } = await seedRun(runId, LIMIT + 1);
      await setLambdaResponse(keyOf(runId, 0), { status: 502, delayMs: 1500 });
      // The Lambda's own token only needs `files:update`.
      const { token: lambdaToken } = await seedTestUser({
        scopes: ["files:update"],
      });

      await reprocessRunRequest(runId);
      await waitForLambdaInvocations(LIMIT);
      const [claimed] = await fileRows(fileIds);
      expect(claimed.status).toBe("processing");
      expect(claimed.dispatchId).not.toBeNull();

      const res = await lambdaApi(`/api/v1/files/${fileIds[0]}`, {
        method: "PATCH",
        token: lambdaToken,
        body: { status: "processing" },
      });
      expect(res.status).toBe(200);
      const [reported] = await fileRows(fileIds);
      expect(reported.status).toBe("processing");
      // The Lambda's update moved the start time and kept the dispatch ID.
      expect(reported.processingStartedAt?.getTime()).toBeGreaterThan(
        claimed.processingStartedAt?.getTime() ?? 0
      );
      expect(reported.dispatchId).toBe(claimed.dispatchId);

      // The Lambda then crashes without saving `failed`, and the Function URL
      // answers 502. The eleventh file takes the freed slot.
      await waitForLambdaInvocations(LIMIT + 1);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT + 1);

      const [failed] = await fileRows(fileIds);
      expect(failed.status).toBe("failed");
      expect(failed.errorMessage).toBe(
        "Processing ended without a result: the Lambda returned HTTP 502. Reprocess the file to try again."
      );
      expect(failed.dispatchId).toBeNull();
      expect(await idsWithStatus(fileIds, "processing")).toEqual(
        fileIds.slice(1, LIMIT + 1)
      );
      expect(await idsWithStatus(fileIds, "queued")).toEqual([]);
    });

    it.each([
      "queued",
      "completed",
    ] as const)("does not fail an S3-style start of a %s file when an older dispatch's 502 arrives", async (before) => {
      const runId = `s3-start-${before}`;
      const { fileIds } = await seedRun(runId, 1);
      await setLambdaResponse(keyOf(runId, 0), { status: 502, delayMs: 1000 });

      await reprocessRunRequest(runId);
      await waitForLambdaInvocations(1);
      // Put the file where an S3 upload would find it, with the dispatch ID
      // still on the row. The PATCH below must clear that ID.
      await getTestDb()
        .update(files)
        .set({
          status: before,
          queuedAt: before === "queued" ? new Date() : null,
          processedAt: before === "completed" ? new Date() : null,
          processingStartedAt: null,
        })
        .where(eq(files.id, fileIds[0]));
      expect((await fileRows(fileIds))[0].dispatchId).not.toBeNull();

      // The Lambda that an S3 upload started reports processing.
      expect((await patchFileRequest(fileIds[0], "processing")).status).toBe(
        200
      );
      expect((await fileRows(fileIds))[0].dispatchId).toBeNull();
      await settleLambdaInvocations(1500);

      const [row] = await fileRows(fileIds);
      expect(row.status).toBe("processing");
      expect(row.errorMessage).toBeNull();
    });

    it.each([
      "completed",
      "failed",
    ] as const)("keeps the dispatch ID until the Lambda saves %s, and then clears it", async (finalStatus) => {
      const runId = `final-${finalStatus}`;
      const { fileIds } = await seedRun(runId, 1);

      await reprocessRunRequest(runId);
      await waitForLambdaInvocations(1);
      const [claimed] = await fileRows(fileIds);
      expect(claimed.dispatchId).not.toBeNull();

      expect((await patchFileRequest(fileIds[0], "processing")).status).toBe(
        200
      );
      expect((await fileRows(fileIds))[0].dispatchId).toBe(claimed.dispatchId);

      expect((await patchFileRequest(fileIds[0], finalStatus)).status).toBe(
        200
      );
      const [done] = await fileRows(fileIds);
      expect(done.status).toBe(finalStatus);
      expect(done.dispatchId).toBeNull();
    });

    it("ends the earlier start when a reprocess request queues the file again", async () => {
      // Ten files are in flight, so the stalled one has to wait in the queue.
      await seedRun("busy", LIMIT, "processing");
      const { fileIds } = await seedRun(
        "stalled-once-started",
        1,
        "processing",
        {
          dispatchId: randomUUID(),
          stallRequeues: 1,
        }
      );
      await startedMinutesAgo(fileIds, 21);

      const res = await reprocessFileRequest(fileIds[0]);
      expect(res.status).toBe(200);
      expect(fileReprocessed.parse(await res.json()).status).toBe("queued");

      const [row] = await fileRows(fileIds);
      expect(row.status).toBe("queued");
      expect(row.dispatchId).toBeNull();
      expect(row.stallRequeues).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // The dispatch lock
  // -------------------------------------------------------------------------

  describe("the dispatch lock", () => {
    // Holds the dispatch lock in a transaction of its own, the way a slow
    // dispatcher would. Resolves once the lock is held, with a `released`
    // promise that settles when the lock is let go. The promise is wrapped in an
    // object: returning it from an async function would make the call wait for
    // the release too.
    async function holdDispatchLock(
      holdMs: number
    ): Promise<{ released: Promise<void> }> {
      let acquired!: () => void;
      const hasLock = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const released = getTestDb().transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${DISPATCH_LOCK_NAME}))`
        );
        acquired();
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      });
      await hasLock;
      return { released };
    }

    it("waits for the dispatcher that holds the lock, and then starts its file", async () => {
      const { fileIds } = await seedRun("lock-wait", 1);
      const { released } = await holdDispatchLock(1500);

      const started = Date.now();
      const res = await reprocessFileRequest(fileIds[0]);
      const waitedMs = Date.now() - started;
      await released;

      expect(res.status).toBe(200);
      // A try-lock would have answered `queued` at once.
      expect(waitedMs).toBeGreaterThanOrEqual(1000);
      expect(fileReprocessed.parse(await res.json()).status).toBe("processing");
      await waitForLambdaInvocations(1);
    });

    it("starts exactly the limit when a burst arrives while another dispatcher holds the lock", async () => {
      // The burst test above races on its own. Here every request reaches the
      // dispatcher while the lock is taken, so a try-lock would start nothing.
      const { fileIds } = await seedRun("burst-locked", 25);
      const { released } = await holdDispatchLock(1500);

      const responses = await Promise.all(
        fileIds.map((id) => reprocessFileRequest(id))
      );
      await released;

      expect(responses.every((r) => r.status === 200)).toBe(true);
      await waitForLambdaInvocations(LIMIT);
      expect(await settleLambdaInvocations()).toHaveLength(LIMIT);
      expect(await idsWithStatus(fileIds, "processing")).toHaveLength(LIMIT);
      expect(await idsWithStatus(fileIds, "queued")).toHaveLength(15);
    });

    it("gives up after five seconds on a reprocess request, which still succeeds and leaves its file queued", async () => {
      const { fileIds } = await seedRun("lock-timeout", 1);
      const { released } = await holdDispatchLock(6500);

      const started = Date.now();
      const res = await reprocessFileRequest(fileIds[0]);
      const waitedMs = Date.now() - started;

      expect(res.status).toBe(200);
      expect(waitedMs).toBeGreaterThanOrEqual(4500);
      expect(waitedMs).toBeLessThan(6500);
      expect(fileReprocessed.parse(await res.json()).status).toBe("queued");
      expect(await idsWithStatus(fileIds, "queued")).toEqual(fileIds);
      expect(await settleLambdaInvocations(200)).toHaveLength(0);

      // Once the lock is free, the cron starts the file.
      await released;
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 1,
      });
      await waitForLambdaInvocations(1);
    });

    it("gives up after five seconds in the cron, which answers 200 and starts nothing", async () => {
      // The cron has no caller to absorb an error, so a lock timeout must not
      // reach it as a 500.
      const { fileIds } = await seedRun("lock-timeout-cron", 1, "queued");
      const { released } = await holdDispatchLock(6500);

      const started = Date.now();
      const res = await runCron(CRON_SECRET);
      const waitedMs = Date.now() - started;

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ started_files: 0 });
      expect(waitedMs).toBeGreaterThanOrEqual(4500);
      expect(waitedMs).toBeLessThan(6500);
      expect(await idsWithStatus(fileIds, "queued")).toEqual(fileIds);

      await released;
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 1,
      });
      await waitForLambdaInvocations(1);
    });
  });

  // -------------------------------------------------------------------------
  // Status transitions on PATCH /api/v1/files/:fileId
  // -------------------------------------------------------------------------

  describe("the queued status", () => {
    it("moves a queued file to processing and clears its queue time", async () => {
      const { fileIds } = await seedRun("s3-reupload", 1, "queued");

      const res = await api(`/api/v1/files/${fileIds[0]}`, {
        method: "PATCH",
        token,
        body: { status: "processing" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("processing");

      const [row] = await fileRows(fileIds);
      expect(row.queuedAt).toBeNull();
      expect(row.processingStartedAt).not.toBeNull();
    });

    it("rejects every other transition out of queued", async () => {
      const { fileIds } = await seedRun("stuck-in-line", 1, "queued");

      for (const status of ["uploaded", "completed", "failed", "detected"]) {
        const res = await api(`/api/v1/files/${fileIds[0]}`, {
          method: "PATCH",
          token,
          body: { status },
        });
        expect(res.status).toBe(409);
        expect((await res.json()).error.details.allowed_transitions).toEqual([
          "processing",
        ]);
      }
      expect((await fileRows(fileIds))[0].status).toBe("queued");
    });

    it("leaves files queued, and not processing, when Lambda is not configured", async () => {
      const { fileIds } = await seedRun("no-lambda", 2, "queued");

      // The main test server has no Lambda Function URL.
      const res = await api("/api/cron/reprocess-queue", {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ started_files: 0 });

      expect(await idsWithStatus(fileIds, "queued")).toEqual(fileIds);
      expect(
        await getTestDb()
          .select({ id: files.id })
          .from(files)
          .where(
            and(inArray(files.id, fileIds), eq(files.status, "processing"))
          )
      ).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // A start that stalled
  // -------------------------------------------------------------------------

  describe("a stalled start that the dispatcher made", () => {
    it("goes back to the back of the queue once, and the oldest waiting file takes the free slot", async () => {
      const { fileIds } = await seedRun("stall-requeue", LIMIT + 2);
      await reprocessRunRequest("stall-requeue");
      await waitForLambdaInvocations(LIMIT);
      const [first] = await fileRows(fileIds);
      expect(first.dispatchId).not.toBeNull();
      expect(first.stallRequeues).toBe(0);

      // A deploy or a crash hit between the claim and the invocation, so no
      // Lambda is behind this file. It stays `processing` past the window.
      await startedMinutesAgo([fileIds[0]], 21);
      const res = await runCron(CRON_SECRET);
      expect(res.status).toBe(200);
      // The stalled file freed a slot, and the oldest waiting file took it.
      expect(await res.json()).toEqual({ started_files: 1 });
      await waitForLambdaInvocations(LIMIT + 1);

      const rows = await fileRows(fileIds);
      expect(rows[0].status).toBe("queued");
      expect(rows[0].stallRequeues).toBe(1);
      expect(rows[0].dispatchId).toBeNull();
      expect(rows[0].processingStartedAt).toBeNull();
      expect(rows[0].errorMessage).toBeNull();
      // Back of the line: later than the file that was already waiting.
      const lastWaiting = rows[LIMIT + 1];
      expect(lastWaiting.status).toBe("queued");
      expect(rows[0].queuedAt?.getTime()).toBeGreaterThan(
        lastWaiting.queuedAt?.getTime() ?? Number.POSITIVE_INFINITY
      );
      expect(rows[LIMIT].status).toBe("processing");
    });

    it("is put back once and only once", async () => {
      const { fileIds } = await seedRun("once", 1);
      await reprocessRunRequest("once");
      await waitForLambdaInvocations(1);
      const [first] = await fileRows(fileIds);

      // The first stall: back in the queue, and started again in the same run
      // of the cron because there is room.
      await startedMinutesAgo(fileIds, 21);
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 1,
      });
      await waitForLambdaInvocations(2);
      const [second] = await fileRows(fileIds);
      expect(second.status).toBe("processing");
      expect(second.stallRequeues).toBe(1);
      expect(second.dispatchId).not.toBeNull();
      expect(second.dispatchId).not.toBe(first.dispatchId);

      // The second stall: the file stays Stalled for a person to handle.
      await startedMinutesAgo(fileIds, 21);
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 0,
      });
      expect(await settleLambdaInvocations()).toHaveLength(2);
      const [third] = await fileRows(fileIds);
      expect(third.status).toBe("processing");
      expect(third.stallRequeues).toBe(1);
      expect(third.dispatchId).toBe(second.dispatchId);
      expect(
        isStalledProcessing({
          status: third.status,
          processingStartedAt: third.processingStartedAt,
        })
      ).toBe(true);
    });

    it("counts a missing start time as stalled, and leaves a start inside the window", async () => {
      const inside = await seedRun("inside-window", 1, "processing", {
        dispatchId: randomUUID(),
      });
      await startedMinutesAgo(inside.fileIds, 19);
      const noStart = await seedRun("no-start-time", 1, "processing", {
        dispatchId: randomUUID(),
        processingStartedAt: null,
      });

      expect(await requeueStalledDispatches()).toBe(1);

      const [insideRow] = await fileRows(inside.fileIds);
      expect(insideRow.status).toBe("processing");
      expect(insideRow.stallRequeues).toBe(0);
      const [noStartRow] = await fileRows(noStart.fileIds);
      expect(noStartRow.status).toBe("queued");
      expect(noStartRow.stallRequeues).toBe(1);
    });

    it("leaves a start that an S3 upload made, which has no dispatch ID", async () => {
      const { fileIds } = await seedRun("s3-started", 1, "processing");
      await startedMinutesAgo(fileIds, 21);

      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 0,
      });
      expect(await settleLambdaInvocations()).toHaveLength(0);
      const [row] = await fileRows(fileIds);
      expect(row.status).toBe("processing");
      expect(row.dispatchId).toBeNull();
      expect(row.stallRequeues).toBe(0);
    });

    it("leaves deleted files, processed artifacts, files in deleted runs, and files already put back once", async () => {
      const stalledDispatch = () => ({ dispatchId: randomUUID() });
      const a = await seedRun("leave-a", 4, "processing", stalledDispatch());
      const [deletedFile, artifact, putBackOnce, eligible] = a.fileIds;
      const b = await seedRun("leave-b", 1, "processing", stalledDispatch());
      await startedMinutesAgo([...a.fileIds, ...b.fileIds], 21);

      const db = getTestDb();
      await db
        .update(files)
        .set({ deletedAt: new Date() })
        .where(eq(files.id, deletedFile));
      await db
        .update(files)
        .set({ category: "processed" })
        .where(eq(files.id, artifact));
      await db
        .update(files)
        .set({ stallRequeues: 1 })
        .where(eq(files.id, putBackOnce));
      await db
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, b.runInternalId));

      expect(await requeueStalledDispatches()).toBe(1);

      expect(
        await idsWithStatus([...a.fileIds, ...b.fileIds], "queued")
      ).toEqual([eligible]);
      expect(
        await idsWithStatus([...a.fileIds, ...b.fileIds], "processing")
      ).toEqual([deletedFile, artifact, putBackOnce, ...b.fileIds]);
    });

    it("is put back only after 20 minutes, even when a shorter window is set", async () => {
      const young = await seedRun("floor-young", 1, "processing", {
        dispatchId: randomUUID(),
      });
      const old = await seedRun("floor-old", 1, "processing", {
        dispatchId: randomUUID(),
      });
      await startedMinutesAgo(young.fileIds, 5);
      await startedMinutesAgo(old.fileIds, 21);

      const previous = process.env.STALLED_PROCESSING_AFTER_MINUTES;
      process.env.STALLED_PROCESSING_AFTER_MINUTES = "1";
      try {
        // A one-minute window is raised to 20 minutes. The five-minute-old
        // start's Lambda may still be running, so it is not Stalled and is not
        // put back.
        const [youngRow] = await fileRows(young.fileIds);
        expect(
          isStalledProcessing({
            status: youngRow.status,
            processingStartedAt: youngRow.processingStartedAt,
          })
        ).toBe(false);
        expect(await requeueStalledDispatches()).toBe(1);
      } finally {
        if (previous === undefined) {
          delete process.env.STALLED_PROCESSING_AFTER_MINUTES;
        } else {
          process.env.STALLED_PROCESSING_AFTER_MINUTES = previous;
        }
      }

      expect(await idsWithStatus(young.fileIds, "processing")).toEqual(
        young.fileIds
      );
      expect(await idsWithStatus(old.fileIds, "queued")).toEqual(old.fileIds);
    });

    it("gets its one retry back after a person reprocesses the file", async () => {
      const { fileIds } = await seedRun("retry-back", 1, "processing", {
        dispatchId: randomUUID(),
        stallRequeues: 1,
      });
      await startedMinutesAgo(fileIds, 21);

      // The file is Stalled and was already put back once, so the cron leaves
      // it. A person reprocesses it, and the count starts again.
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 0,
      });
      const res = await reprocessFileRequest(fileIds[0]);
      expect(res.status).toBe(200);
      await waitForLambdaInvocations(1);
      const [restarted] = await fileRows(fileIds);
      expect(restarted.status).toBe("processing");
      expect(restarted.stallRequeues).toBe(0);
      expect(restarted.dispatchId).not.toBeNull();

      await startedMinutesAgo(fileIds, 21);
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 1,
      });
      await waitForLambdaInvocations(2);
      expect((await fileRows(fileIds))[0].stallRequeues).toBe(1);
    });

    it("is left alone when the Lambda is not configured", async () => {
      // The main test server has no Lambda Function URL. Nothing could start a
      // file that went back in the queue, so the cron does not put it there.
      const { fileIds } = await seedRun("no-lambda-stall", 1, "processing", {
        dispatchId: randomUUID(),
      });
      await startedMinutesAgo(fileIds, 21);

      const res = await api("/api/cron/reprocess-queue", {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      expect(res.status).toBe(200);
      const [row] = await fileRows(fileIds);
      expect(row.status).toBe("processing");
      expect(row.stallRequeues).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cancelling queued files
  // -------------------------------------------------------------------------

  describe("cancelling queued files", () => {
    // The main test server has no Lambda Function URL: cancelling is how a
    // person clears files that nothing can start.
    function cancelRequest(
      runId: string,
      options: { token?: string; headers?: Record<string, string> } = {
        token,
      }
    ) {
      return api(
        `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/cancel-queued`,
        { method: "POST", ...options }
      );
    }

    async function runUpdatedAt(runInternalId: string) {
      const [run] = await getTestDb()
        .select({ updatedAt: instrumentRuns.updatedAt })
        .from(instrumentRuns)
        .where(eq(instrumentRuns.id, runInternalId));
      return run.updatedAt.getTime();
    }

    it("fails the run's queued files with a message, and leaves every other file alone", async () => {
      // The `dispatchId` on these queued rows is stale on purpose: cancelling
      // clears it.
      const queued = await seedRun("cancel-me", 3, "queued", {
        dispatchId: randomUUID(),
      });
      const db = getTestDb();
      const run = { id: queued.runInternalId };

      // More files in the same run: one for each other status, and a queued
      // file that was dismissed.
      const extraRows = await db
        .insert(files)
        .values(
          (
            [
              ["uploaded.csv", "uploaded"],
              ["running.csv", "processing"],
              ["done.csv", "completed"],
              ["broken.csv", "failed"],
              ["dismissed.csv", "queued"],
            ] as const
          ).map(([filename, status]) => ({
            instrumentRunId: run.id,
            filename,
            relativePath: filename,
            s3Bucket: "test-bucket",
            s3Key: `${instrumentId}/cancel-me/${filename}`,
            category: "raw" as const,
            status,
            queuedAt: status === "queued" ? new Date() : null,
            processingStartedAt: status === "processing" ? new Date() : null,
            dispatchId: status === "processing" ? randomUUID() : null,
            errorMessage: status === "failed" ? "parser error" : null,
            deletedAt: filename === "dismissed.csv" ? new Date() : null,
          }))
        )
        .returning({ id: files.id });
      const extraIds = extraRows.map((r) => r.id);
      const extraBefore = await fileRows(extraIds);
      const updatedBefore = await runUpdatedAt(run.id);

      const res = await cancelRequest("cancel-me");
      expect(res.status).toBe(200);
      const data = runQueuedCancelled.parse(await res.json());
      expect(data).toEqual({
        instrument_id: instrumentId,
        run_id: "cancel-me",
        files_cancelled: 3,
      });

      for (const row of await fileRows(queued.fileIds)) {
        expect(row.status).toBe("failed");
        expect(row.errorMessage).toBe(
          "Reprocessing was cancelled before it started. Reprocess the file to try again."
        );
        expect(row.queuedAt).toBeNull();
        expect(row.dispatchId).toBeNull();
        expect(row.processedAt).not.toBeNull();
      }
      // The other files, including the dismissed queued one, are unchanged.
      expect(await fileRows(extraIds)).toEqual(extraBefore);
      expect(await runUpdatedAt(run.id)).toBeGreaterThan(updatedBefore);
    });

    it("answers 0 when no file is queued, and does not touch other runs", async () => {
      await seedRun("nothing-queued", 2, "completed");
      const other = await seedRun("other-run", 2, "queued");

      const res = await cancelRequest("nothing-queued");
      expect(res.status).toBe(200);
      expect(runQueuedCancelled.parse(await res.json()).files_cancelled).toBe(
        0
      );
      expect(await idsWithStatus(other.fileIds, "queued")).toEqual(
        other.fileIds
      );
    });

    it("answers 404 for an unknown run or instrument", async () => {
      const run = await cancelRequest("no-such-run");
      expect(run.status).toBe(404);
      expect((await run.json()).error.code).toBe("NOT_FOUND");

      const instrument = await api(
        "/api/v1/instruments/no-such-instrument/runs/anything/cancel-queued",
        { method: "POST", token }
      );
      expect(instrument.status).toBe(404);
    });

    it("clears the queued files of a deleted run, and skips deleted files", async () => {
      const { fileIds, runInternalId } = await seedRun(
        "deleted-run-queue",
        3,
        "queued"
      );
      const db = getTestDb();
      await db
        .update(files)
        .set({ deletedAt: new Date() })
        .where(eq(files.id, fileIds[0]));
      await db
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, runInternalId));

      const res = await cancelRequest("deleted-run-queue");
      expect(res.status).toBe(200);
      expect(runQueuedCancelled.parse(await res.json()).files_cancelled).toBe(
        2
      );
      expect(await idsWithStatus(fileIds, "failed")).toEqual(fileIds.slice(1));
      expect(await idsWithStatus(fileIds, "queued")).toEqual([fileIds[0]]);
    });

    it("needs the same scope as reprocessing a run, and accepts a browser session", async () => {
      await seedRun("auth-run", 1, "queued");

      expect((await cancelRequest("auth-run", {})).status).toBe(401);

      const readOnly = await seedTestUser({ scopes: ["runs:read"] });
      const denied = await cancelRequest("auth-run", {
        token: readOnly.token,
      });
      expect(denied.status).toBe(403);

      const person = await seedTestUser();
      const viaSession = await cancelRequest("auth-run", {
        headers: { Cookie: await seedSessionCookie(person.userId) },
      });
      expect(viaSession.status).toBe(200);
      expect(
        runQueuedCancelled.parse(await viaSession.json()).files_cancelled
      ).toBe(1);

      // `runs:reprocess` alone is enough.
      const reprocessor = await seedTestUser({ scopes: ["runs:reprocess"] });
      const allowed = await cancelRequest("auth-run", {
        token: reprocessor.token,
      });
      expect(allowed.status).toBe(200);
    });

    it("leaves cancelled files out of the queue until someone reprocesses them", async () => {
      const { fileIds } = await seedRun("cancel-then-retry", 2, "queued");
      expect(
        (await (await cancelRequest("cancel-then-retry")).json())
          .files_cancelled
      ).toBe(2);

      // The dispatcher has nothing to start.
      expect(await (await runCron(CRON_SECRET)).json()).toEqual({
        started_files: 0,
      });
      expect(await settleLambdaInvocations(300)).toHaveLength(0);

      // A cancelled file can be reprocessed like any failed file.
      const res = await reprocessFileRequest(fileIds[0]);
      expect(res.status).toBe(200);
      expect(fileReprocessed.parse(await res.json()).status).toBe("processing");
      await waitForLambdaInvocations(1);
      const [retried] = await fileRows([fileIds[0]]);
      expect(retried.status).toBe("processing");
      expect(retried.errorMessage).toBeNull();
      expect((await fileRows([fileIds[1]]))[0].status).toBe("failed");
    });
  });

  // -------------------------------------------------------------------------
  // The cron when the Lambda is not configured
  // -------------------------------------------------------------------------

  describe("the cron when the Lambda is not configured", () => {
    const WARNING =
      /queued for reprocessing, but the Lambda is not configured/g;

    async function cronWarnings(): Promise<number> {
      const offset = serverLogSize();
      const res = await api("/api/cron/reprocess-queue", {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ started_files: 0 });
      return (await readServerLogSince(offset)).match(WARNING)?.length ?? 0;
    }

    it("logs one warning per run while files are waiting in the queue", async () => {
      await seedRun("warn-me", 3, "queued");

      expect(await cronWarnings()).toBe(1);
      expect(await cronWarnings()).toBe(1);
    });

    it("logs nothing when no queued file could start", async () => {
      expect(await cronWarnings()).toBe(0);

      // A queued file in a deleted run cannot start, so it is not a reason to
      // warn.
      const { runInternalId } = await seedRun("warn-deleted", 1, "queued");
      await getTestDb()
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, runInternalId));
      expect(await cronWarnings()).toBe(0);
    });
  });
});
