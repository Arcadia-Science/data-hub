import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DISPATCH_LOCK_NAME,
  hasStartableQueuedFiles,
} from "@/lib/api/file-reprocessing";
import {
  fileReprocessed,
  runListResponse,
  runReprocessed,
} from "@/lib/api/openapi";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
import {
  api,
  clearLambdaInvocations,
  closeTestDb,
  getTestDb,
  lambdaApi,
  resetDb,
  seedTestUser,
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

async function seedRun(
  runId: string,
  count: number,
  status: FileStatus = "uploaded"
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
      }
      for (const r of queued) {
        expect(r.queuedAt).not.toBeNull();
        expect(r.processingStartedAt).toBeNull();
        expect(r.errorMessage).toBeNull();
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
      await getTestDb()
        .update(files)
        .set({ processingStartedAt: new Date(Date.now() - 21 * MINUTE_MS) })
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

    it("does not fail a start that a newer start has replaced", async () => {
      const runId = "restarted";
      const { fileIds } = await seedRun(runId, 1);
      await setLambdaResponse(keyOf(runId, 0), { status: 502, delayMs: 800 });

      await reprocessRunRequest(runId);
      await waitForLambdaInvocations(1);
      // Another start of the same file, with its own start time.
      const newerStart = new Date(Date.now() + 60 * 1000);
      await getTestDb()
        .update(files)
        .set({ processingStartedAt: newerStart })
        .where(eq(files.id, fileIds[0]));
      await settleLambdaInvocations(1200);

      const [row] = await fileRows(fileIds);
      expect(row.status).toBe("processing");
      expect(row.errorMessage).toBeNull();
      expect(row.processingStartedAt?.getTime()).toBe(newerStart.getTime());
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
});
