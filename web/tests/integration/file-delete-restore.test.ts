import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DeleteFilesOutcome,
  deleteFiles,
  findLinkedFiles,
  type RestoreFilesOutcome,
  restoreFiles,
  uniqueLinkedFiles,
} from "@/lib/api/file-deletion";
import { reviveProcessedFile } from "@/lib/api/files";
import {
  buildRunFilesQuery,
  getRunFileStats,
  getRunFilesPage,
} from "@/lib/api/instrument-runs";
import { taggedFilename } from "@/lib/api/run-file-identity";
import { WATCHER_VERSION_HEADER } from "@/lib/api/watcher-compat";
import { clearAutoUploadMarks } from "@/lib/api/watchers";
import {
  files,
  instrumentRuns,
  instruments,
  notebooks,
  runComments,
  runNotebookLinks,
  watcherEvents,
  watchers,
} from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getMcpAccessToken,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";
import {
  TEST_PROCESSED_BUCKET,
  TEST_RAW_BUCKET,
} from "@/tests/integration/test-buckets";

// Deleting and restoring individual files of a run. Each test names the row of
// the spec's "Rules and edge cases" table it covers. Files are seeded straight
// into the database, in the shapes the watcher and the processors write, and
// the REST routes and `deleteFiles` / `restoreFiles` are driven for real. The
// names are synthetic: a DishCam-like run with one capture, two copies of it,
// and the preview video, image and sidecar files that go with them.

const instrumentId = "delete-restore-dishcam";
const watcherHeaders = { [WATCHER_VERSION_HEADER]: "1.1.0" };

type NewFile = typeof files.$inferInsert;
interface Actor {
  kind: "token";
  tokenId: string;
  tokenName: string;
}

const MINUTE_MS = 60 * 1000;

let token: string;
let tokenId: string;
let personId: string;
let personCookie: string;
let mcpToken: string;
let runCounter = 0;

interface TestRun {
  id: string;
  runId: string;
}

async function seedRun(name = "run"): Promise<TestRun> {
  runCounter += 1;
  const runId = `${name}-${runCounter}`;
  const [run] = await getTestDb()
    .insert(instrumentRuns)
    .values({ instrumentId, runId, source: "watcher" })
    .returning({ id: instrumentRuns.id });
  return { id: run.id, runId };
}

// A raw file that reached S3 and was processed.
async function seedRaw(
  run: TestRun,
  filename: string,
  values: Partial<NewFile> = {}
) {
  const [row] = await getTestDb()
    .insert(files)
    .values({
      instrumentRunId: run.id,
      relativePath: filename,
      filename,
      status: "completed",
      s3Bucket: TEST_RAW_BUCKET,
      s3Key: `${instrumentId}/${run.runId}/${filename}`,
      sizeBytes: 100,
      uploadedAt: new Date(),
      ...values,
    })
    .returning();
  return row;
}

// A file that is still on the instrument PC.
async function seedPreUpload(
  run: TestRun,
  filename: string,
  values: Partial<NewFile> = {}
) {
  const [row] = await getTestDb()
    .insert(files)
    .values({
      instrumentRunId: run.id,
      relativePath: filename,
      filename,
      status: "detected",
      sizeBytes: 100,
      detectedAt: new Date(),
      ...values,
    })
    .returning();
  return row;
}

async function seedProcessed(
  run: TestRun,
  filename: string,
  sourceFileId: number | null,
  values: Partial<NewFile> = {}
) {
  const [row] = await getTestDb()
    .insert(files)
    .values({
      instrumentRunId: run.id,
      relativePath: filename,
      filename,
      category: "processed",
      status: "uploaded",
      s3Bucket: TEST_PROCESSED_BUCKET,
      s3Key: `${instrumentId}/${run.runId}/${filename}`,
      contentType: filename.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
      sizeBytes: filename.endsWith(".mp4") ? 1000 : 50,
      uploadedAt: new Date(),
      sourceFileId,
      ...values,
    })
    .returning();
  return row;
}

async function readFile(id: number) {
  const [row] = await getTestDb().select().from(files).where(eq(files.id, id));
  return row;
}

async function runRow(run: TestRun) {
  const [row] = await getTestDb()
    .select()
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, run.id));
  return row;
}

function asToken(): Actor {
  return { kind: "token", tokenId, tokenName: "Test User" };
}

async function deleteOne(id: number) {
  const { results } = await deleteFiles([id], asToken(), {
    includeLinked: false,
  });
  return results[0];
}

function remove(id: number, headers: Record<string, string> = {}) {
  return api(`/api/v1/files/${id}`, { method: "DELETE", token, headers });
}

function registerFile(run: TestRun, body: Record<string, unknown>) {
  return api(`/api/v1/instruments/${instrumentId}/runs/${run.runId}/files`, {
    method: "POST",
    token,
    body,
  });
}

function reportFiles(
  run: TestRun,
  detected: Record<string, unknown>[],
  headers: Record<string, string> = watcherHeaders
) {
  return api(`/api/v1/instruments/${instrumentId}/runs/${run.runId}`, {
    method: "PATCH",
    token,
    headers,
    body: { detected_files: detected },
  });
}

async function runFileRows(run: TestRun) {
  return await getTestDb()
    .select()
    .from(files)
    .where(eq(files.instrumentRunId, run.id))
    .orderBy(files.id);
}

async function runFilenames(run: TestRun, { deleted }: { deleted: boolean }) {
  return (await runFileRows(run))
    .filter((row) => (row.deletedAt !== null) === deleted)
    .map((row) => row.filename)
    .sort();
}

// The deleted files the run page counts beside "Show deleted files".
async function deletedCountOf(runInternalId: string) {
  const page = await buildRunFilesQuery(runInternalId, {
    page: 1,
    perPage: 100,
  });
  return page.deletedCount;
}

// The ENG-2154 shape. One capture folder holds the original, an uploaded copy
// of it, and the original's sidecar. A second folder holds a second copy under
// a tagged name, with its own sidecar. Every capture has a video and a preview
// image.
async function seedDuplicateCaptures() {
  const run = await seedRun("20260101_demo");
  const original = await seedRaw(run, "s001_A.tif", {
    relativePath: "cap_a/s001_A.tif",
  });
  const copy = await seedRaw(run, "s001_A_1.tif", {
    relativePath: "cap_a/s001_A_1.tif",
  });
  const taggedName = "s001_A_1~0a1b2c3d.tif";
  const tagged = await seedRaw(run, taggedName, {
    relativePath: "cap_b/s001_A_1.tif",
  });
  const sidecarA = await seedRaw(run, "run.json", {
    relativePath: "cap_a/run.json",
    sizeBytes: 10,
    contentType: "application/json",
  });
  const sidecarB = await seedRaw(run, "run~0a1b2c3d.json", {
    relativePath: "cap_b/run.json",
    sizeBytes: 10,
    contentType: "application/json",
  });
  const outputs: Record<string, Awaited<ReturnType<typeof seedProcessed>>> = {};
  for (const [name, source] of [
    ["s001_A", original],
    ["s001_A_1", copy],
    ["s001_A_1~0a1b2c3d", tagged],
  ] as const) {
    outputs[`${name}.mp4`] = await seedProcessed(run, `${name}.mp4`, source.id);
    outputs[`${name}.jpg`] = await seedProcessed(run, `${name}.jpg`, source.id);
  }
  return { run, original, copy, tagged, sidecarA, sidecarB, outputs };
}

describe("Deleting and restoring files", () => {
  beforeAll(async () => {
    await resetDb();
    ({ token, tokenId } = await seedTestUser({ tokenName: "Test User" }));
    const person = await seedTestUser({ email: "person@example.com" });
    personId = person.userId;
    personCookie = await seedSessionCookie(personId);
    mcpToken = await getMcpAccessToken(personId);
    await getTestDb().insert(instruments).values({
      id: instrumentId,
      displayName: "Delete Restore DishCam",
      status: "active",
      instrumentType: "dishcam",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Who can delete or restore
  // -------------------------------------------------------------------------

  describe("who can delete", () => {
    it("lets a signed-in person delete a file and records them", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      const res = await api(`/api/v1/files/${file.id}`, {
        method: "DELETE",
        headers: { Cookie: personCookie },
      });
      expect(res.status).toBe(200);

      const row = await readFile(file.id);
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBe(personId);
      expect(row.deletedByToken).toBeNull();
    });

    it("lets a token with files:delete delete a file and records the token", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      expect((await remove(file.id)).status).toBe(200);

      const row = await readFile(file.id);
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBeNull();
      expect(row.deletedByToken).toBe(tokenId);
    });

    it("refuses a token without files:delete", async () => {
      const limited = await seedTestUser({
        scopes: ["files:read"],
        email: "reader@example.com",
      });
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      const res = await api(`/api/v1/files/${file.id}`, {
        method: "DELETE",
        token: limited.token,
      });
      expect(res.status).toBe(403);
      expect((await readFile(file.id)).deletedAt).toBeNull();
    });

    it("records the person when a user is the actor", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      const { results } = await deleteFiles(
        [file.id],
        { kind: "user", userId: personId },
        { includeLinked: false }
      );

      expect(results[0]).toMatchObject({
        ok: true,
        deletedBy: personId,
        deletedByToken: null,
        alreadyApplied: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // The state a file is in
  // -------------------------------------------------------------------------

  describe("a file that is not in S3 yet", () => {
    const cases: [string, () => Partial<NewFile>][] = [
      ["not uploaded", () => ({ status: "detected" })],
      [
        "waiting to upload",
        () => ({ status: "detected", autoUploadExpectedAt: new Date() }),
      ],
      [
        "uploading",
        () => ({
          status: "upload_requested",
          uploadRequestedAt: new Date(),
          uploadRequestedBy: personId,
        }),
      ],
      [
        "upload failed",
        () => ({
          status: "upload_failed",
          uploadFailedAt: new Date(),
          uploadFailureReason: "file_missing",
          errorMessage: "The file is gone",
        }),
      ],
    ];

    it.each(cases)("can be deleted when it is %s", async (_label, values) => {
      const run = await seedRun();
      const file = await seedPreUpload(run, "a.csv", values());

      const result = await deleteOne(file.id);

      expect(result).toMatchObject({ ok: true, alreadyApplied: false });
      expect((await readFile(file.id)).deletedAt).not.toBeNull();
    });

    it("has its upload request cancelled, with no watcher event", async () => {
      const run = await seedRun();
      const [watcher] = await getTestDb()
        .insert(watchers)
        .values({
          instrumentId,
          hostname: "dishcam-pc",
          status: "watching",
          lastHeartbeatAt: new Date(),
        })
        .returning({ id: watchers.id });
      const queued = await seedPreUpload(run, "queued.csv", {
        status: "upload_requested",
        uploadRequestedAt: new Date(),
        uploadRequestedBy: personId,
      });
      const marked = await seedPreUpload(run, "marked.csv", {
        autoUploadExpectedAt: new Date(),
      });
      const other = await seedPreUpload(run, "other.csv", {
        status: "upload_requested",
        uploadRequestedAt: new Date(),
      });

      await deleteFiles([queued.id, marked.id], asToken(), {
        includeLinked: false,
      });

      const deleted = await readFile(queued.id);
      expect(deleted.deletedAt).not.toBeNull();
      // It reads "Not uploaded" if it is ever restored, not "Uploading".
      expect(deleted.status).toBe("detected");
      expect(deleted.uploadRequestedAt).toBeNull();
      expect(deleted.uploadRequestedBy).toBeNull();
      expect((await readFile(marked.id)).autoUploadExpectedAt).toBeNull();
      // A request for a file that was not deleted is left alone.
      expect((await readFile(other.id)).status).toBe("upload_requested");
      // The watcher's queue never lists a deleted file, so it needs no event.
      const events = await getTestDb()
        .select({ id: watcherEvents.id })
        .from(watcherEvents)
        .where(eq(watcherEvents.watcherId, watcher.id));
      expect(events).toEqual([]);
    });
  });

  describe("a file that is in S3", () => {
    it.each([
      "uploaded",
      "completed",
      "failed",
    ] as const)("can be deleted when it is %s", async (status) => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif", {
        status,
        errorMessage: status === "failed" ? "boom" : null,
      });

      const result = await deleteOne(file.id);

      expect(result).toMatchObject({ ok: true, alreadyApplied: false });
      const row = await readFile(file.id);
      expect(row.deletedAt).not.toBeNull();
      // The row and its S3 location stay as they were.
      expect(row.status).toBe(status);
      expect(row.s3Key).toBe(file.s3Key);
    });

    it("can be deleted when it is stalled", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif", {
        status: "processing",
        processingStartedAt: new Date(Date.now() - 25 * MINUTE_MS),
      });

      const result = await deleteOne(file.id);

      expect(result).toMatchObject({ ok: true });
      expect((await readFile(file.id)).deletedAt).not.toBeNull();
    });

    it.each([
      ["queued", { queuedAt: new Date() }],
      ["processing", { processingStartedAt: new Date() }],
    ] as const)("is refused when it is %s", async (status, extra) => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif", { status, ...extra });
      const before = (await runRow(run)).updatedAt;

      const result = await deleteOne(file.id);

      expect(result).toMatchObject({
        ok: false,
        status: 409,
        code: "CONFLICT",
        details: { reason: "file_processing" },
      });
      expect(result.ok === false && result.message).toContain(
        "Wait for processing to finish"
      );
      expect((await readFile(file.id)).deletedAt).toBeNull();
      expect((await runRow(run)).updatedAt).toEqual(before);
    });

    it("lets the others in the same request go when one is refused", async () => {
      const run = await seedRun();
      const busy = await seedRaw(run, "busy.tif", {
        status: "processing",
        processingStartedAt: new Date(),
      });
      const idle = await seedRaw(run, "idle.tif");

      const { results } = await deleteFiles([busy.id, idle.id], asToken(), {
        includeLinked: false,
      });

      expect(results.map((result) => result.ok)).toEqual([false, true]);
      expect((await readFile(busy.id)).deletedAt).toBeNull();
      expect((await readFile(idle.id)).deletedAt).not.toBeNull();
    });

    it("keeps a sidecar when the raw file in its folder was refused", async () => {
      const run = await seedRun();
      const busy = await seedRaw(run, "busy.tif", {
        relativePath: "cap/busy.tif",
        status: "processing",
        processingStartedAt: new Date(),
      });
      const idle = await seedRaw(run, "idle.tif", {
        relativePath: "cap/idle.tif",
      });
      const sidecar = await seedRaw(run, "run.json", {
        relativePath: "cap/run.json",
      });

      const { linked } = await deleteFiles([busy.id, idle.id], asToken(), {
        includeLinked: true,
      });

      // The folder still has an active raw file, so its sidecar stays.
      expect(linked).toEqual([]);
      expect((await readFile(idle.id)).deletedAt).not.toBeNull();
      expect((await readFile(sidecar.id)).deletedAt).toBeNull();
    });

    it("answers 404 for a file that does not exist", async () => {
      const { results } = await deleteFiles([999_999_999], asToken(), {
        includeLinked: false,
      });
      expect(results[0]).toMatchObject({
        ok: false,
        status: 404,
        code: "NOT_FOUND",
      });
    });
  });

  // -------------------------------------------------------------------------
  // The run
  // -------------------------------------------------------------------------

  describe("a deleted run", () => {
    it("refuses to delete or restore a file, with run_deleted", async () => {
      const run = await seedRun();
      const active = await seedRaw(run, "active.tif");
      const gone = await seedRaw(run, "gone.tif");
      await deleteOne(gone.id);
      await getTestDb()
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, run.id));

      const deleting = await deleteFiles([active.id], asToken(), {
        includeLinked: false,
      });
      const restoring = await restoreFiles([gone.id], asToken(), {
        includeLinked: false,
      });

      for (const result of [deleting.results[0], restoring.results[0]]) {
        expect(result).toMatchObject({
          ok: false,
          status: 409,
          code: "CONFLICT",
          details: { reason: "run_deleted" },
        });
      }
      expect((await readFile(active.id)).deletedAt).toBeNull();
      expect((await readFile(gone.id)).deletedAt).not.toBeNull();
    });

    it("answers a REST delete with 409 and run_deleted", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      const res = await api(
        `/api/v1/instruments/${instrumentId}/runs/${run.runId}`,
        { method: "DELETE", token }
      );
      expect(res.status).toBe(200);

      const refused = await remove(file.id);
      expect(refused.status).toBe(409);
      expect((await refused.json()).error.details.reason).toBe("run_deleted");
    });

    it("keeps files deleted one by one deleted after the run is restored", async () => {
      const run = await seedRun();
      const first = await seedRaw(run, "first.tif");
      const second = await seedRaw(run, "second.tif");
      await deleteOne(first.id);

      const runPath = `/api/v1/instruments/${instrumentId}/runs/${run.runId}`;
      expect((await api(runPath, { method: "DELETE", token })).status).toBe(
        200
      );
      // Deleting a run never sets a file's `deleted_at`.
      expect((await readFile(second.id)).deletedAt).toBeNull();

      expect(
        (await api(`${runPath}/restore`, { method: "POST", token })).status
      ).toBe(200);
      expect((await readFile(first.id)).deletedAt).not.toBeNull();
      expect((await readFile(second.id)).deletedAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Deleting twice
  // -------------------------------------------------------------------------

  describe("a file that is already deleted", () => {
    it("succeeds with already_applied and changes nothing", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      const first = await remove(file.id);
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody.already_applied).toBe(false);
      const stored = await readFile(file.id);
      const touched = (await runRow(run)).updatedAt;

      // A second caller, a different person, sees success as well.
      const second = await api(`/api/v1/files/${file.id}`, {
        method: "DELETE",
        headers: { Cookie: personCookie },
      });
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.already_applied).toBe(true);
      expect(secondBody.deleted_at).toBe(firstBody.deleted_at);

      const after = await readFile(file.id);
      expect(after.deletedAt).toEqual(stored.deletedAt);
      expect(after.deletedBy).toBeNull();
      expect(after.deletedByToken).toBe(tokenId);
      expect((await runRow(run)).updatedAt).toEqual(touched);
    });

    it("is skipped when it is a linked file, and not counted", async () => {
      const { run, copy, outputs } = await seedDuplicateCaptures();
      // The copy's video was deleted on its own earlier.
      const video = outputs["s001_A_1.mp4"];
      await deleteOne(video.id);

      const groups = await findLinkedFiles([copy.id], { mode: "delete" });

      expect(groups).toHaveLength(1);
      expect(groups[0]?.linked.map((file) => file.filename)).toEqual([
        "s001_A_1.jpg",
      ]);
      const outcome = await deleteFiles([copy.id], asToken(), {
        includeLinked: true,
      });
      expect(outcome.linked.map((file) => file.filename)).toEqual([
        "s001_A_1.jpg",
      ]);
      // The video keeps the time and the person of its own delete.
      expect((await readFile(video.id)).deletedByToken).toBe(tokenId);
      expect(await runFilenames(run, { deleted: true })).toContain(
        "s001_A_1.mp4"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Linked files
  // -------------------------------------------------------------------------

  describe("linked files", () => {
    it("are the outputs of a raw file and the sidecar of a folder that is going whole", async () => {
      const { copy, tagged, sidecarA, sidecarB } =
        await seedDuplicateCaptures();

      const groups = await findLinkedFiles([copy.id, tagged.id], {
        mode: "delete",
      });

      const byFile = new Map(
        groups.map((group) => [
          group.fileId,
          group.linked.map((file) => `${file.filename}:${file.relation}`),
        ])
      );
      expect(byFile.get(copy.id)).toEqual([
        "s001_A_1.mp4:video",
        "s001_A_1.jpg:preview_image",
      ]);
      expect(byFile.get(tagged.id)).toEqual([
        "s001_A_1~0a1b2c3d.mp4:video",
        "s001_A_1~0a1b2c3d.jpg:preview_image",
        "run~0a1b2c3d.json:sidecar",
      ]);
      const everyId = uniqueLinkedFiles(groups).map((file) => file.id);
      expect(everyId).toContain(sidecarB.id);
      // The original's sidecar sits in the copy's folder, beside the original
      // that is staying, so it is not offered.
      expect(everyId).not.toContain(sidecarA.id);
    });

    it("offer a folder's sidecar once every raw file in the folder goes", async () => {
      const { original, copy, sidecarA } = await seedDuplicateCaptures();

      const groups = await findLinkedFiles([original.id, copy.id], {
        mode: "delete",
      });

      expect(uniqueLinkedFiles(groups).map((file) => file.id)).toContain(
        sidecarA.id
      );
      // The sidecar is listed under both raw files of its folder.
      expect(
        groups.filter((group) =>
          group.linked.some((file) => file.id === sidecarA.id)
        )
      ).toHaveLength(2);
    });

    it("leave a processed file that no single raw file made", async () => {
      const run = await seedRun();
      const first = await seedRaw(run, "plate_1.csv");
      const second = await seedRaw(run, "plate_2.csv");
      // Made from the whole run, so it records no source.
      const combined = await seedProcessed(
        run,
        `${run.runId}_combined.csv`,
        null
      );

      const groups = await findLinkedFiles([first.id, second.id], {
        mode: "delete",
      });
      const outcome = await deleteFiles([first.id, second.id], asToken(), {
        includeLinked: true,
      });

      expect(groups).toEqual([]);
      expect(outcome.linked).toEqual([]);
      expect((await readFile(combined.id)).deletedAt).toBeNull();
    });

    it("are found for a processed file's source when restoring", async () => {
      const { copy, outputs } = await seedDuplicateCaptures();
      await deleteFiles([copy.id], asToken(), { includeLinked: true });

      const groups = await findLinkedFiles(
        [outputs["s001_A_1.mp4"].id, copy.id],
        { mode: "restore" }
      );

      // The video comes back with its source, and the source with its
      // other output. The ids asked about are never listed as linked.
      expect(
        groups
          .find((group) => group.fileId === copy.id)
          ?.linked.map((file) => file.filename)
      ).toEqual(["s001_A_1.jpg"]);
      expect(
        groups.find((group) => group.fileId === outputs["s001_A_1.mp4"].id)
      ).toBeUndefined();

      const fromVideoOnly = await findLinkedFiles(
        [outputs["s001_A_1.mp4"].id],
        { mode: "restore" }
      );
      expect(fromVideoOnly[0]?.linked).toMatchObject([
        { id: copy.id, relation: "made_from" },
      ]);
    });

    it("bring back a folder's sidecar when any raw file there is restored", async () => {
      const { original, copy, sidecarA } = await seedDuplicateCaptures();
      await deleteFiles([original.id, copy.id], asToken(), {
        includeLinked: true,
      });
      expect((await readFile(sidecarA.id)).deletedAt).not.toBeNull();

      // Restoring one of the two brings the sidecar back for it.
      const groups = await findLinkedFiles([copy.id], { mode: "restore" });

      expect(uniqueLinkedFiles(groups).map((file) => file.filename)).toContain(
        "run.json"
      );
    });
  });

  // -------------------------------------------------------------------------
  // The ENG-2154 scenario
  // -------------------------------------------------------------------------

  describe("deleting the duplicate uploads of a capture", () => {
    it("deletes exactly the two copies and what was made from them, and undo brings them back", async () => {
      const { run, original, copy, tagged, sidecarA, sidecarB, outputs } =
        await seedDuplicateCaptures();
      const before = await getRunFileStats(run.id);
      expect(before).toMatchObject({
        active: 11,
        rawActive: 5,
        processedActive: 6,
      });
      expect(await deletedCountOf(run.id)).toBe(0);

      const outcome = await deleteFiles([copy.id, tagged.id], asToken(), {
        includeLinked: true,
      });

      const expected = [
        "s001_A_1.tif",
        "s001_A_1~0a1b2c3d.tif",
        "s001_A_1.mp4",
        "s001_A_1.jpg",
        "s001_A_1~0a1b2c3d.mp4",
        "s001_A_1~0a1b2c3d.jpg",
        "run~0a1b2c3d.json",
      ];
      expect(outcome.results.every((result) => result.ok)).toBe(true);
      expect(await runFilenames(run, { deleted: true })).toEqual(
        [...expected].sort()
      );
      // The capture that was uploaded first is untouched.
      expect(await runFilenames(run, { deleted: false })).toEqual(
        ["s001_A.tif", "s001_A.mp4", "s001_A.jpg", "run.json"].sort()
      );
      for (const kept of [
        original,
        sidecarA,
        outputs["s001_A.mp4"],
        outputs["s001_A.jpg"],
      ]) {
        expect((await readFile(kept.id)).deletedAt).toBeNull();
      }
      expect((await readFile(sidecarB.id)).deletedAt).not.toBeNull();
      const afterDelete = await getRunFileStats(run.id);
      expect(afterDelete).toMatchObject({
        active: 4,
        rawActive: 2,
        processedActive: 2,
      });
      expect(await deletedCountOf(run.id)).toBe(7);

      // Neither the REST detail nor the file page lists the deleted files.
      const detail = await api(
        `/api/v1/instruments/${instrumentId}/runs/${run.runId}`,
        { token }
      );
      const listed = (await detail.json()).files.map(
        (file: { filename: string }) => file.filename
      );
      expect(listed.sort()).toEqual(
        ["s001_A.tif", "s001_A.mp4", "s001_A.jpg", "run.json"].sort()
      );
      const page = await getRunFilesPage(run.id, { page: 1, perPage: 50 });
      expect(page.pagination.total).toBe(4);
      const withDeleted = await getRunFilesPage(run.id, {
        page: 1,
        perPage: 50,
        includeDeleted: true,
      });
      expect(withDeleted.pagination.total).toBe(11);

      // Undo restores the ids its delete returned, and nothing else.
      const undone = [
        ...outcome.results.map((result) => result.id),
        ...outcome.linked.map((file) => file.id),
      ];
      expect(undone).toHaveLength(7);
      const restored = await restoreFiles(undone, asToken(), {
        includeLinked: false,
      });
      expect(restored.results.every((result) => result.ok)).toBe(true);

      const afterRestore = await getRunFileStats(run.id);
      expect(afterRestore).toEqual(before);
      expect(await runFilenames(run, { deleted: true })).toEqual([]);
      const restoredRows = await Promise.all(undone.map(readFile));
      for (const row of restoredRows) {
        expect(row.deletedAt).toBeNull();
        expect(row.deletedBy).toBeNull();
        expect(row.deletedByToken).toBeNull();
      }
    });

    it("restores the copy with its linked files when asked", async () => {
      const { run, copy } = await seedDuplicateCaptures();
      await deleteFiles([copy.id], asToken(), { includeLinked: true });
      expect(await runFilenames(run, { deleted: true })).toEqual(
        ["s001_A_1.tif", "s001_A_1.mp4", "s001_A_1.jpg"].sort()
      );

      const restored = await restoreFiles([copy.id], asToken(), {
        includeLinked: true,
      });

      expect(restored.results[0]).toMatchObject({ ok: true });
      expect(restored.linked.map((file) => file.filename).sort()).toEqual([
        "s001_A_1.jpg",
        "s001_A_1.mp4",
      ]);
      expect(await runFilenames(run, { deleted: true })).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The run's counts and "Last Updated"
  // -------------------------------------------------------------------------

  describe("the run", () => {
    it("changes its Last Updated on every delete and restore", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      const t0 = (await runRow(run)).updatedAt;

      await deleteOne(file.id);
      const t1 = (await runRow(run)).updatedAt;
      expect(t1.getTime()).toBeGreaterThan(t0.getTime());

      await restoreFiles([file.id], asToken(), { includeLinked: false });
      const t2 = (await runRow(run)).updatedAt;
      expect(t2.getTime()).toBeGreaterThan(t1.getTime());
    });

    it("stops counting a deleted failed file, so its status changes", async () => {
      const run = await seedRun("status");
      const failed = await seedRaw(run, "failed.tif", {
        status: "failed",
        errorMessage: "boom",
      });
      await seedRaw(run, "fine.tif");
      const runsWith = async (status: string) => {
        const res = await api(
          `/api/v1/instrument-runs?instrument_id=${instrumentId}&per_page=100&status=${status}`,
          { token }
        );
        return (await res.json()).data.map(
          (row: { run_id: string }) => row.run_id
        ) as string[];
      };
      expect(await runsWith("failed")).toContain(run.runId);

      await deleteOne(failed.id);

      expect(await runsWith("failed")).not.toContain(run.runId);
      expect(await runsWith("completed")).toContain(run.runId);
      const stats = await getRunFileStats(run.id);
      expect(stats.failed).toBe(0);
    });

    it("acts on file ids, however many there are", async () => {
      const run = await seedRun();
      const rows = await getTestDb()
        .insert(files)
        .values(
          Array.from({ length: 120 }, (_, index) => ({
            instrumentRunId: run.id,
            relativePath: `many/${index}.csv`,
            filename: `${index}.csv`,
            status: "completed" as const,
            s3Bucket: TEST_RAW_BUCKET,
            s3Key: `${instrumentId}/${run.runId}/${index}.csv`,
          }))
        )
        .returning({ id: files.id });
      const ids = rows.map((row) => row.id);

      const { results } = await deleteFiles(ids, asToken(), {
        includeLinked: false,
      });
      expect(results).toHaveLength(120);
      expect(results.every((result) => result.ok)).toBe(true);

      const restored = await restoreFiles(ids, asToken(), {
        includeLinked: false,
      });
      expect(restored.results.every((result) => result.ok)).toBe(true);
      expect(await runFilenames(run, { deleted: true })).toEqual([]);
    });

    it("leaves comments and notebook links as they were", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      await getTestDb()
        .insert(runComments)
        .values({ runId: run.id, userId: personId, body: "Looks fine" });
      const [notebook] = await getTestDb()
        .insert(notebooks)
        .values({
          url: "https://notebook.example.com/page",
          urlKey: `notebook.example.com/page-${run.runId}`,
          name: "Demo notebook",
        })
        .returning({ id: notebooks.id });
      await getTestDb()
        .insert(runNotebookLinks)
        .values({ runId: run.id, notebookId: notebook.id });

      await deleteOne(file.id);
      await restoreFiles([file.id], asToken(), { includeLinked: false });
      await deleteOne(file.id);

      const comments = await getTestDb()
        .select({ body: runComments.body, deletedAt: runComments.deletedAt })
        .from(runComments)
        .where(eq(runComments.runId, run.id));
      expect(comments).toEqual([{ body: "Looks fine", deletedAt: null }]);
      const links = await getTestDb()
        .select({ notebookId: runNotebookLinks.notebookId })
        .from(runNotebookLinks)
        .where(eq(runNotebookLinks.runId, run.id));
      expect(links).toEqual([{ notebookId: notebook.id }]);
    });
  });

  // -------------------------------------------------------------------------
  // Restoring
  // -------------------------------------------------------------------------

  describe("restoring", () => {
    it("clears who deleted the file and the time", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      await deleteOne(file.id);

      const { results } = await restoreFiles([file.id], asToken(), {
        includeLinked: false,
      });

      expect(results[0]).toMatchObject({ ok: true, alreadyApplied: false });
      const row = await readFile(file.id);
      expect(row.deletedAt).toBeNull();
      expect(row.deletedBy).toBeNull();
      expect(row.deletedByToken).toBeNull();
    });

    it("succeeds with already_applied for a file that is not deleted", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      const touched = (await runRow(run)).updatedAt;

      const { results } = await restoreFiles([file.id], asToken(), {
        includeLinked: false,
      });

      expect(results[0]).toMatchObject({ ok: true, alreadyApplied: true });
      expect((await runRow(run)).updatedAt).toEqual(touched);
    });

    it("is refused when an active file now holds the same path, and names it", async () => {
      const run = await seedRun();
      const gone = await seedPreUpload(run, "sample.tif", {
        relativePath: "cap/sample.tif",
        deletedAt: new Date(),
      });
      // A file the watcher reported later at the same path.
      const holder = await seedPreUpload(run, "sample.tif", {
        relativePath: "cap/sample.tif",
      });
      const fine = await seedRaw(run, "fine.tif", { deletedAt: new Date() });

      const { results } = await restoreFiles([gone.id, fine.id], asToken(), {
        includeLinked: false,
      });

      expect(results[0]).toMatchObject({
        ok: false,
        status: 409,
        code: "CONFLICT",
        details: {
          reason: "path_in_use",
          held_by: { id: holder.id, filename: "sample.tif" },
        },
      });
      expect(results[0]?.ok === false && results[0].message).toContain(
        `File ${holder.id}`
      );
      // The other file in the request still comes back.
      expect(results[1]).toMatchObject({ ok: true });
      expect((await readFile(gone.id)).deletedAt).not.toBeNull();
      expect((await readFile(fine.id)).deletedAt).toBeNull();
    });

    it("is refused when an active file holds only the name", async () => {
      const run = await seedRun();
      const gone = await seedRaw(run, "same-name.tif", {
        relativePath: "day-1/same-name.tif",
        deletedAt: new Date(),
      });
      const holder = await seedPreUpload(run, "same-name.tif", {
        relativePath: "day-2/same-name.tif",
      });

      const { results } = await restoreFiles([gone.id], asToken(), {
        includeLinked: false,
      });

      expect(results[0]).toMatchObject({
        ok: false,
        details: { reason: "path_in_use", held_by: { id: holder.id } },
      });
    });

    it("lets the first of two files that want one name take it", async () => {
      const run = await seedRun();
      const first = await seedPreUpload(run, "twin.tif", {
        relativePath: "twin.tif",
        deletedAt: new Date(),
      });
      const second = await seedPreUpload(run, "twin.tif", {
        relativePath: "twin.tif",
        deletedAt: new Date(),
      });

      const { results } = await restoreFiles([first.id, second.id], asToken(), {
        includeLinked: false,
      });

      expect(results[0]).toMatchObject({ ok: true });
      expect(results[1]).toMatchObject({
        ok: false,
        details: { reason: "path_in_use", held_by: { id: first.id } },
      });
    });

    // Two restores that both found the name free: the unique indexes let one
    // win, and the other gets the same refusal as a file that was held at the
    // start. A transaction that has restored the first file but not committed
    // holds the second restore at the index until it ends.
    it("refuses a restore that loses a race for the name, through the unique index", async () => {
      const run = await seedRun();
      const first = await seedPreUpload(run, "race.tif", {
        relativePath: "race.tif",
        deletedAt: new Date(),
      });
      const second = await seedPreUpload(run, "race.tif", {
        relativePath: "race.tif",
        deletedAt: new Date(),
      });

      let pending: Promise<RestoreFilesOutcome> | undefined;
      await getTestDb().transaction(async (tx) => {
        await tx
          .update(files)
          .set({ deletedAt: null })
          .where(eq(files.id, first.id));
        pending = restoreFiles([second.id], asToken(), {
          includeLinked: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 750));
      });
      const outcome = await pending;

      expect(outcome?.results[0]).toMatchObject({
        ok: false,
        status: 409,
        details: { reason: "path_in_use", held_by: { id: first.id } },
      });
      expect((await readFile(second.id)).deletedAt).not.toBeNull();
    });

    // A file dismissed before upload holds neither its path nor its name, so a
    // different file found at that path later can take the plain name, upload
    // and then be deleted. Restoring the first file would make it upload under
    // that same key, over the deleted file's object.
    it("is refused for a file never uploaded when a deleted file's stored object has its name", async () => {
      const run = await seedRun();
      const dismissed = await seedPreUpload(run, "held.tif", {
        relativePath: "cap/held.tif",
        deletedAt: new Date(),
      });
      const uploaded = await seedRaw(run, "held.tif", {
        relativePath: "cap/held.tif",
        sizeBytes: 900,
      });
      await deleteOne(uploaded.id);

      const refused = await restoreFiles([dismissed.id], asToken(), {
        includeLinked: false,
      });

      expect(refused.results[0]).toMatchObject({
        ok: false,
        status: 409,
        details: {
          reason: "path_in_use",
          held_by: { id: uploaded.id, filename: "held.tif" },
        },
      });
      expect((await readFile(dismissed.id)).deletedAt).not.toBeNull();

      // The uploaded file has its own object, so it comes back.
      const restored = await restoreFiles([uploaded.id], asToken(), {
        includeLinked: false,
      });
      expect(restored.results[0]).toMatchObject({ ok: true });
    });
  });

  // -------------------------------------------------------------------------
  // The watcher reports a deleted file again
  // -------------------------------------------------------------------------

  describe("a deleted file the watcher reports again", () => {
    const createdAt = "2026-09-21T17:00:00.123Z";

    async function seedDeletedUpload(run: TestRun) {
      const uploaded = await seedRaw(run, "sample.tif", {
        relativePath: "cap/sample.tif",
        status: "uploaded",
        sizeBytes: 50,
        fileCreatedAt: new Date(createdAt),
      });
      await deleteOne(uploaded.id);
      return uploaded;
    }

    const same = {
      relative_path: "cap/sample.tif",
      filename: "sample.tif",
      size_bytes: 50,
      file_created_at: createdAt,
    };
    const different = { ...same, size_bytes: 900 };

    it("stays deleted when it is the same file", async () => {
      const run = await seedRun();
      const uploaded = await seedDeletedUpload(run);

      const res = await reportFiles(run, [same]);
      expect(res.status).toBe(200);

      const rows = await runFileRows(run);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(uploaded.id);
      expect(rows[0]?.deletedAt).not.toBeNull();
    });

    it("stores a different file at that path under a new name and never rewrites the old object", async () => {
      const run = await seedRun();
      const uploaded = await seedDeletedUpload(run);

      expect((await reportFiles(run, [different])).status).toBe(200);

      const rows = await runFileRows(run);
      expect(rows).toHaveLength(2);
      const fresh = rows.find((row) => row.id !== uploaded.id);
      expect(fresh).toMatchObject({
        filename: taggedFilename("sample.tif", "cap/sample.tif"),
        relativePath: "cap/sample.tif",
        deletedAt: null,
        sizeBytes: 900,
        s3Key: null,
      });
      // The deleted file keeps its name and its key.
      const old = await readFile(uploaded.id);
      expect(old.filename).toBe("sample.tif");
      expect(old.s3Key).toBe(uploaded.s3Key);

      // The new file uploads under its own key, not the deleted file's.
      const upload = await api(
        `/api/v1/instruments/${instrumentId}/runs/${run.runId}/request-upload-url`,
        {
          method: "POST",
          token,
          headers: watcherHeaders,
          body: different,
        }
      );
      expect(upload.status).toBe(200);
      const body = await upload.json();
      expect(body.file_id).toBe(fresh?.id);
      expect(body.s3_key).toBe(
        `${instrumentId}/${run.runId}/${taggedFilename("sample.tif", "cap/sample.tif")}`
      );
      expect(body.s3_key).not.toBe(uploaded.s3Key);
    });

    it("is not stored again for a watcher that can't rename", async () => {
      const run = await seedRun();
      await seedDeletedUpload(run);

      // A watcher before 1.1.0 can only upload under the name it reports,
      // which the deleted file still holds.
      expect((await reportFiles(run, [different], {})).status).toBe(200);
      const upload = await api(
        `/api/v1/instruments/${instrumentId}/runs/${run.runId}/request-upload-url`,
        { method: "POST", token, body: different }
      );
      expect(upload.status).toBe(409);
      expect(await runFileRows(run)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The processor registers its output
  // -------------------------------------------------------------------------

  describe("registering a processed file", () => {
    it("revives a deleted processed row, so a reprocess leaves an active file", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");
      const preview = await seedProcessed(run, "s001_A.jpg", raw.id, {
        metadata: { stale: true },
        processedAt: new Date(),
        errorMessage: "old",
      });
      await deleteOne(preview.id);
      const touched = (await runRow(run)).updatedAt;

      const res = await registerFile(run, {
        s3_bucket: TEST_PROCESSED_BUCKET,
        s3_key: preview.s3Key,
        filename: "s001_A.jpg",
        category: "processed",
        content_type: "image/png",
        size_bytes: 77,
        source_file_id: raw.id,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(preview.id);
      expect(body.deleted_at).toBeNull();
      expect(body.status).toBe("uploaded");
      const row = await readFile(preview.id);
      expect(row).toMatchObject({
        deletedAt: null,
        deletedBy: null,
        deletedByToken: null,
        status: "uploaded",
        contentType: "image/png",
        sizeBytes: 77,
        sourceFileId: raw.id,
        errorMessage: null,
        processedAt: null,
        metadata: {},
      });
      // One row, not a second one beside the deleted one.
      expect(await runFileRows(run)).toHaveLength(2);
      expect((await runRow(run)).updatedAt.getTime()).toBeGreaterThan(
        touched.getTime()
      );
    });

    it("keeps the source it had when the request names none", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");
      const preview = await seedProcessed(run, "s001_A.jpg", raw.id);
      await deleteOne(preview.id);

      const res = await registerFile(run, {
        s3_bucket: TEST_PROCESSED_BUCKET,
        s3_key: preview.s3Key,
        filename: "s001_A.jpg",
        category: "processed",
      });

      expect(res.status).toBe(200);
      expect((await readFile(preview.id)).sourceFileId).toBe(raw.id);
      expect((await readFile(preview.id)).deletedAt).toBeNull();
    });

    it("saves a revived output as deleted, in the same way, when its raw file is deleted", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");
      const preview = await seedProcessed(run, "s001_A.jpg", raw.id);
      // The output was deleted by a person, and the raw file by the token.
      await deleteFiles(
        [preview.id],
        { kind: "user", userId: personId },
        { includeLinked: false }
      );
      await deleteOne(raw.id);
      const rawRow = await readFile(raw.id);

      const res = await registerFile(run, {
        s3_bucket: TEST_PROCESSED_BUCKET,
        s3_key: preview.s3Key,
        filename: "s001_A.jpg",
        category: "processed",
        size_bytes: 12,
        source_file_id: raw.id,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted_at).not.toBeNull();
      const row = await readFile(preview.id);
      expect(row.status).toBe("uploaded");
      expect(row.sizeBytes).toBe(12);
      expect(row.deletedAt).toEqual(rawRow.deletedAt);
      expect(row.deletedBy).toBeNull();
      expect(row.deletedByToken).toBe(tokenId);
    });

    it("saves a new output as deleted, with the same actor, when its raw file was deleted meanwhile", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");
      await deleteFiles(
        [raw.id],
        { kind: "user", userId: personId },
        { includeLinked: false }
      );
      const rawRow = await readFile(raw.id);

      const res = await registerFile(run, {
        s3_bucket: TEST_PROCESSED_BUCKET,
        s3_key: `${instrumentId}/${run.runId}/s001_A.mp4`,
        filename: "s001_A.mp4",
        category: "processed",
        content_type: "video/mp4",
        size_bytes: 1000,
        source_file_id: raw.id,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.deleted_at).not.toBeNull();
      const [row] = await getTestDb()
        .select()
        .from(files)
        .where(eq(files.id, body.id));
      expect(row).toMatchObject({
        status: "uploaded",
        category: "processed",
        sourceFileId: raw.id,
        deletedBy: personId,
        deletedByToken: null,
      });
      expect(row.deletedAt).toEqual(rawRow.deletedAt);
    });

    it("saves a new output as active, linked to its source", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");

      const res = await registerFile(run, {
        s3_bucket: TEST_PROCESSED_BUCKET,
        s3_key: `${instrumentId}/${run.runId}/s001_A.mp4`,
        filename: "s001_A.mp4",
        category: "processed",
        source_file_id: raw.id,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.deleted_at).toBeNull();
      expect((await readFile(body.id)).sourceFileId).toBe(raw.id);
    });

    it("never revives a deleted raw row", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif", { status: "completed" });
      await deleteOne(raw.id);

      const res = await registerFile(run, {
        s3_bucket: TEST_RAW_BUCKET,
        s3_key: raw.s3Key,
        filename: "s001_A.tif",
      });

      // Returned as it is: still deleted, status unchanged, no second row.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(raw.id);
      expect(body.deleted_at).not.toBeNull();
      expect(body.status).toBe("completed");
      const row = await readFile(raw.id);
      expect(row.deletedAt).not.toBeNull();
      expect(row.status).toBe("completed");
      expect(await runFileRows(run)).toHaveLength(1);
    });

    it("returns an active row as it is", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");
      const preview = await seedProcessed(run, "s001_A.jpg", raw.id, {
        sizeBytes: 5,
      });

      const res = await registerFile(run, {
        s3_bucket: TEST_PROCESSED_BUCKET,
        s3_key: preview.s3Key,
        filename: "s001_A.jpg",
        category: "processed",
        size_bytes: 77,
        source_file_id: raw.id,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(preview.id);
      expect(body.deleted_at).toBeNull();
      expect(await runFileRows(run)).toHaveLength(2);
    });

    it("refuses to revive when another active file holds the row's path", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");
      const preview = await seedProcessed(run, "s001_A.jpg", raw.id);
      await deleteOne(preview.id);
      // An active row took the path while the output was deleted.
      await seedPreUpload(run, "other-name.jpg", {
        relativePath: "s001_A.jpg",
      });

      const revived = await reviveProcessedFile(preview.id, {
        contentType: "image/jpeg",
        sizeBytes: 5,
        sourceFileId: raw.id,
      });

      expect(revived.kind).toBe("conflict");
      expect((await readFile(preview.id)).deletedAt).not.toBeNull();
    });

    it("does not revive a row that was restored in the meantime", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");
      const preview = await seedProcessed(run, "s001_A.jpg", raw.id, {
        sizeBytes: 5,
      });

      const revived = await reviveProcessedFile(preview.id, {
        contentType: "image/png",
        sizeBytes: 99,
        sourceFileId: raw.id,
      });

      expect(revived.kind).toBe("unchanged");
      expect((await readFile(preview.id)).sizeBytes).toBe(5);
    });

    it("links an active output that has no source to the one a reprocess names", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");
      // An output from before outputs recorded their source, which the
      // backfill could not match.
      const preview = await seedProcessed(run, "s001_A.jpg", null);

      const res = await registerFile(run, {
        s3_bucket: TEST_PROCESSED_BUCKET,
        s3_key: preview.s3Key,
        filename: "s001_A.jpg",
        category: "processed",
        source_file_id: raw.id,
      });

      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(preview.id);
      expect((await readFile(preview.id)).sourceFileId).toBe(raw.id);
    });

    it("never replaces the source an active output already has", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "s001_A.tif");
      const other = await seedRaw(run, "s002_A.tif");
      const preview = await seedProcessed(run, "s001_A.jpg", raw.id);

      const res = await registerFile(run, {
        s3_bucket: TEST_PROCESSED_BUCKET,
        s3_key: preview.s3Key,
        filename: "s001_A.jpg",
        category: "processed",
        source_file_id: other.id,
      });

      expect(res.status).toBe(200);
      expect((await readFile(preview.id)).sourceFileId).toBe(raw.id);
    });

    // A delete of the raw file that is still open when the output is
    // registered. The route reads the source with a share lock, so it waits for
    // the delete to commit and then saves the output deleted. Without the lock
    // it read the source as active and saved the output active.
    describe("while its raw file is being deleted", () => {
      async function deleteHeldOpenWhile(
        raw: { id: number },
        register: () => Promise<Response>
      ): Promise<Response> {
        let pending: Promise<Response> | undefined;
        await getTestDb().transaction(async (tx) => {
          await tx
            .select({ id: files.id })
            .from(files)
            .where(eq(files.id, raw.id))
            .for("update");
          await tx
            .update(files)
            .set({ deletedAt: new Date(), deletedByToken: tokenId })
            .where(eq(files.id, raw.id));
          pending = register();
          await waitForLockWait();
        });
        if (!pending) {
          throw new Error("The register request never started");
        }
        return await pending;
      }

      it("saves a new output deleted", async () => {
        const run = await seedRun();
        const raw = await seedRaw(run, "s001_A.tif", { status: "processing" });

        const res = await deleteHeldOpenWhile(raw, () =>
          registerFile(run, {
            s3_bucket: TEST_PROCESSED_BUCKET,
            s3_key: `${instrumentId}/${run.runId}/s001_A.mp4`,
            filename: "s001_A.mp4",
            category: "processed",
            source_file_id: raw.id,
          })
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        const output = await readFile(body.id);
        expect(output.deletedAt).toEqual((await readFile(raw.id)).deletedAt);
        expect(output.deletedByToken).toBe(tokenId);
      });

      it("keeps a revived output deleted", async () => {
        const run = await seedRun();
        const raw = await seedRaw(run, "s001_A.tif", { status: "processing" });
        const preview = await seedProcessed(run, "s001_A.jpg", raw.id);
        await deleteFiles(
          [preview.id],
          { kind: "user", userId: personId },
          { includeLinked: false }
        );

        const res = await deleteHeldOpenWhile(raw, () =>
          registerFile(run, {
            s3_bucket: TEST_PROCESSED_BUCKET,
            s3_key: preview.s3Key,
            filename: "s001_A.jpg",
            category: "processed",
            source_file_id: raw.id,
          })
        );

        expect(res.status).toBe(200);
        const row = await readFile(preview.id);
        expect(row.status).toBe("uploaded");
        expect(row.deletedAt).toEqual((await readFile(raw.id)).deletedAt);
        expect(row.deletedBy).toBeNull();
        expect(row.deletedByToken).toBe(tokenId);
      });
    });

    describe("source_file_id", () => {
      function post(run: TestRun, body: Record<string, unknown>) {
        return registerFile(run, {
          s3_bucket: TEST_PROCESSED_BUCKET,
          s3_key: `${instrumentId}/${run.runId}/out.jpg`,
          filename: "out.jpg",
          category: "processed",
          ...body,
        });
      }

      it("must name a raw file of the same run", async () => {
        const run = await seedRun();
        const otherRun = await seedRun();
        const mine = await seedRaw(run, "mine.tif");
        const theirs = await seedRaw(otherRun, "theirs.tif");
        const processed = await seedProcessed(run, "made.jpg", mine.id);

        for (const sourceId of [theirs.id, processed.id, 999_999_999]) {
          const res = await post(run, { source_file_id: sourceId });
          expect(res.status).toBe(400);
          expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
        }
        expect(await runFilenames(run, { deleted: false })).toEqual([
          "made.jpg",
          "mine.tif",
        ]);

        expect((await post(run, { source_file_id: mine.id })).status).toBe(201);
      });

      it("is only for a processed file", async () => {
        const run = await seedRun();
        const raw = await seedRaw(run, "mine.tif");

        const res = await registerFile(run, {
          s3_bucket: TEST_RAW_BUCKET,
          s3_key: `${instrumentId}/${run.runId}/second.tif`,
          filename: "second.tif",
          source_file_id: raw.id,
        });

        expect(res.status).toBe(400);
        expect((await res.json()).error.message).toContain("processed");
      });

      it("may name a raw file that is deleted", async () => {
        const run = await seedRun();
        const raw = await seedRaw(run, "mine.tif");
        await deleteOne(raw.id);

        const res = await post(run, { source_file_id: raw.id });

        expect(res.status).toBe(201);
        expect((await res.json()).deleted_at).not.toBeNull();
      });
    });
  });

  describe("updating a deleted file", () => {
    it("is refused with 409 and file_deleted", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "a.tif", { status: "uploaded" });
      await deleteOne(raw.id);

      const res = await api(`/api/v1/files/${raw.id}`, {
        method: "PATCH",
        token,
        body: { status: "processing" },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.details).toEqual({ reason: "file_deleted" });
      expect((await readFile(raw.id)).status).toBe("uploaded");
    });
  });

  // -------------------------------------------------------------------------
  // Reprocessing, and reading a deleted file
  // -------------------------------------------------------------------------

  describe("a deleted file elsewhere", () => {
    it("cannot be reprocessed", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "a.tif");
      await deleteOne(raw.id);

      const res = await api(`/api/v1/files/${raw.id}/reprocess`, {
        method: "POST",
        token,
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error.message).toContain("soft-deleted");
    });

    it("can still be downloaded by its id", async () => {
      const run = await seedRun();
      const raw = await seedRaw(run, "a.tif");
      const never = await seedPreUpload(run, "never.tif");
      await deleteOne(raw.id);
      await deleteOne(never.id);

      const res = await api(`/api/v1/files/${raw.id}/download`, {
        token,
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain(raw.s3Key);

      // A file that never reached S3 has nothing to download.
      const missing = await api(`/api/v1/files/${never.id}/download`, {
        token,
        redirect: "manual",
      });
      expect(missing.status).toBe(404);
    });

    it("is not counted in the run's files, sizes or status", async () => {
      const run = await seedRun();
      const kept = await seedRaw(run, "kept.tif", { sizeBytes: 300 });
      const gone = await seedRaw(run, "gone.tif", { sizeBytes: 700 });
      await deleteOne(gone.id);

      const stats = await getRunFileStats(run.id);
      expect(stats).toMatchObject({
        active: 1,
        rawActive: 1,
        rawTotalSizeBytes: 300,
      });
      expect(await deletedCountOf(run.id)).toBe(1);
      const res = await api(
        `/api/v1/instrument-runs?instrument_id=${instrumentId}&per_page=100`,
        { token }
      );
      const row = (await res.json()).data.find(
        (r: { run_id: string }) => r.run_id === run.runId
      );
      expect(row.file_count).toBe(1);
      expect(Number(row.total_size_bytes)).toBe(300);
      expect(kept.id).not.toBe(gone.id);
    });

    it("keeps its auto-upload mark, and its run's Last Updated, when a manual-mode heartbeat clears the marks", async () => {
      const goneRun = await seedRun();
      // Deleted by hand, so it still carries the mark an old dismiss left.
      const gone = await seedPreUpload(goneRun, "gone.csv", {
        autoUploadExpectedAt: new Date(),
        deletedAt: new Date(),
      });
      const waitingRun = await seedRun();
      const waiting = await seedPreUpload(waitingRun, "waiting.csv", {
        autoUploadExpectedAt: new Date(),
      });
      const goneBefore = (await runRow(goneRun)).updatedAt;
      const waitingBefore = (await runRow(waitingRun)).updatedAt;

      await clearAutoUploadMarks(instrumentId);

      expect((await readFile(waiting.id)).autoUploadExpectedAt).toBeNull();
      expect((await runRow(waitingRun)).updatedAt.getTime()).toBeGreaterThan(
        waitingBefore.getTime()
      );
      expect((await readFile(gone.id)).autoUploadExpectedAt).not.toBeNull();
      expect((await runRow(goneRun)).updatedAt).toEqual(goneBefore);
    });

    it("is not listed by the run's file page unless asked", async () => {
      const run = await seedRun();
      await seedRaw(run, "kept.tif");
      const gone = await seedRaw(run, "gone.tif");
      await deleteOne(gone.id);

      const page = await getRunFilesPage(run.id, { page: 1, perPage: 50 });
      expect(page.data.map((file) => file.filename)).toEqual(["kept.tif"]);
      expect(page.pagination.total).toBe(1);

      const all = await getRunFilesPage(run.id, {
        page: 1,
        perPage: 50,
        includeDeleted: true,
      });
      expect(all.data.map((file) => file.filename).sort()).toEqual([
        "gone.tif",
        "kept.tif",
      ]);

      const completedOnly = await getRunFilesPage(run.id, {
        page: 1,
        perPage: 50,
        statuses: ["completed"],
      });
      expect(completedOnly.data.map((file) => file.filename)).toEqual([
        "kept.tif",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------

  describe("through MCP", () => {
    async function callTool(name: string, args: Record<string, unknown>) {
      const res = await api("/mcp/v1", {
        method: "POST",
        token: mcpToken,
        headers: { Accept: "application/json, text/event-stream" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const dataLine = text
        .split("\n")
        .find((line) => line.startsWith("data: "));
      const result = JSON.parse((dataLine ?? "").slice("data: ".length)).result;
      return {
        isError: result.isError as boolean | undefined,
        text: result.content[0].text as string,
      };
    }

    it("dismiss_file deletes an uploaded file, and the run's file list no longer shows it", async () => {
      const run = await seedRun();
      const kept = await seedRaw(run, "kept.tif");
      const gone = await seedRaw(run, "gone.tif");

      const deleted = await callTool("dismiss_file", { fileId: gone.id });
      expect(deleted.isError).toBeFalsy();
      expect(JSON.parse(deleted.text)).toMatchObject({
        id: gone.id,
        filename: "gone.tif",
        alreadyApplied: false,
      });
      const row = await readFile(gone.id);
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBe(personId);
      expect(row.deletedByToken).toBeNull();

      const listed = await callTool("list_run_files", {
        instrumentId,
        runId: run.runId,
      });
      expect(
        JSON.parse(listed.text).data.map((file: { id: number }) => file.id)
      ).toEqual([kept.id]);

      const detail = await callTool("get_run", {
        instrumentId,
        runId: run.runId,
        include: ["files"],
      });
      expect(
        JSON.parse(detail.text).files.map((file: { id: number }) => file.id)
      ).toEqual([kept.id]);

      // The link still works for the deleted file.
      const link = await callTool("get_file_download_url", {
        fileId: gone.id,
      });
      expect(link.isError).toBeFalsy();
      expect(JSON.parse(link.text).downloadUrl).toContain(gone.s3Key);
    });

    it("dismiss_file says why a file that is processing can't be deleted", async () => {
      const run = await seedRun();
      const busy = await seedRaw(run, "busy.tif", {
        status: "processing",
        processingStartedAt: new Date(),
      });

      const refused = await callTool("dismiss_file", { fileId: busy.id });

      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Wait for processing to finish");
      expect((await readFile(busy.id)).deletedAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------

  describe("two calls at once", () => {
    it("both succeed, and one of them does the delete", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      const [first, second] = await Promise.all([
        deleteFiles([file.id], asToken(), { includeLinked: false }),
        deleteFiles(
          [file.id],
          { kind: "user", userId: personId },
          { includeLinked: false }
        ),
      ]);

      const applied = [first, second].map((outcome) => {
        const result = outcome.results[0];
        return result?.ok ? result.alreadyApplied : null;
      });
      expect(applied.sort()).toEqual([false, true]);
      expect((await readFile(file.id)).deletedAt).not.toBeNull();
    });

    // The Lambda's PATCH to an output changes the file and then moves its
    // run's "Last Updated". A delete that takes the output along must wait for
    // it without holding the run, or each waits for the other.
    it("waits for a change to a linked file and its run instead of deadlocking", async () => {
      const { run, copy, outputs } = await seedDuplicateCaptures();
      const video = outputs["s001_A_1.mp4"];

      let pending: Promise<DeleteFilesOutcome> | undefined;
      await getTestDb().transaction(async (tx) => {
        await tx
          .update(files)
          .set({ sizeBytes: 2000 })
          .where(eq(files.id, video.id));
        pending = deleteFiles([copy.id], asToken(), { includeLinked: true });
        await waitForLockWait();
        await tx
          .update(instrumentRuns)
          .set({ updatedAt: new Date() })
          .where(eq(instrumentRuns.id, run.id));
      });
      const outcome = await pending;

      expect(outcome?.results[0]).toMatchObject({ ok: true });
      expect(outcome?.linked.map((file) => file.id)).toContain(video.id);
      expect((await readFile(video.id)).deletedAt).not.toBeNull();
    });

    it("waits the same way when a restore brings a linked file back", async () => {
      const { run, copy, outputs } = await seedDuplicateCaptures();
      const video = outputs["s001_A_1.mp4"];
      await deleteFiles([copy.id], asToken(), { includeLinked: true });

      let pending: Promise<RestoreFilesOutcome> | undefined;
      await getTestDb().transaction(async (tx) => {
        await tx
          .update(files)
          .set({ sizeBytes: 2000 })
          .where(eq(files.id, video.id));
        pending = restoreFiles([copy.id], asToken(), { includeLinked: true });
        await waitForLockWait();
        await tx
          .update(instrumentRuns)
          .set({ updatedAt: new Date() })
          .where(eq(instrumentRuns.id, run.id));
      });
      const outcome = await pending;

      expect(outcome?.results[0]).toMatchObject({ ok: true });
      expect(outcome?.linked.map((file) => file.id)).toContain(video.id);
      expect((await readFile(video.id)).deletedAt).toBeNull();
    });
  });
});

// Resolves once another connection waits for a row lock on `files`.
async function waitForLockWait() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await getTestDb().execute(
      sql`select 1 from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query ilike '%"files"%'`
    );
    if (waiting.rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The delete never waited for the row lock");
}
