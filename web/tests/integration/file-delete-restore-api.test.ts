import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fileDeleted,
  fileRestored,
  runDetail,
  runFilesDeleted,
  runFilesLinked,
  runFilesRestored,
} from "@/lib/api/openapi";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
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

// The REST routes and MCP tools that delete and restore the files of a run:
// DELETE and POST .../restore for one file, POST .../files/delete and
// .../files/restore for up to 100, GET .../files/linked, and the deleted files
// on run detail and list_run_files. What deleting does to a file, the run and
// the watcher's rules is in file-delete-restore.test.ts. This file covers the
// request and response contracts: scope, limits, one result per file, the
// files taken along, and who is named as the deleter. The names are synthetic.

const instrumentId = "delete-restore-api";

type NewFile = typeof files.$inferInsert;
type Row = typeof files.$inferSelect;

let token: string;
let tokenId: string;
let personId: string;
let personCookie: string;
let mcpToken: string;
// `files:read` and `runs:delete` are the nearest scopes to `files:delete`.
// Neither grants deleting a file.
let readOnlyToken: string;
let runsOnlyToken: string;
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

async function readFile(id: number): Promise<Row> {
  const [row] = await getTestDb().select().from(files).where(eq(files.id, id));
  return row;
}

async function isDeleted(id: number): Promise<boolean> {
  return (await readFile(id)).deletedAt !== null;
}

// A run with two captures. Folder `fold_a` holds two raw files and the
// `run.json` they share. Folder `fold_b` holds one raw file and its own
// sidecar. Every raw file has a video and a preview image.
async function seedCaptures() {
  const run = await seedRun("captures");
  const one = await seedRaw(run, "sample_1.tif", {
    relativePath: "fold_a/sample_1.tif",
  });
  const two = await seedRaw(run, "sample_2.tif", {
    relativePath: "fold_a/sample_2.tif",
  });
  const three = await seedRaw(run, "sample_3.tif", {
    relativePath: "fold_b/sample_3.tif",
  });
  const sidecarA = await seedRaw(run, "run.json", {
    relativePath: "fold_a/run.json",
    sizeBytes: 10,
    contentType: "application/json",
  });
  const sidecarB = await seedRaw(run, "run~0a1b2c3d.json", {
    relativePath: "fold_b/run.json",
    sizeBytes: 10,
    contentType: "application/json",
  });
  const outputs: Record<string, Row> = {};
  for (const [stem, source] of [
    ["sample_1", one],
    ["sample_2", two],
    ["sample_3", three],
  ] as const) {
    outputs[`${stem}.mp4`] = await seedProcessed(run, `${stem}.mp4`, source.id);
    outputs[`${stem}.jpg`] = await seedProcessed(run, `${stem}.jpg`, source.id);
  }
  return { run, one, two, three, sidecarA, sidecarB, outputs };
}

function runPath(run: TestRun) {
  return `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(run.runId)}`;
}

function deleteFile(
  id: number,
  { linked = false, as }: { linked?: boolean; as?: string } = {}
) {
  return api(`/api/v1/files/${id}${linked ? "?include_linked=true" : ""}`, {
    method: "DELETE",
    token: as ?? token,
  });
}

function restoreFile(
  id: number,
  { linked = false, as }: { linked?: boolean; as?: string } = {}
) {
  return api(
    `/api/v1/files/${id}/restore${linked ? "?include_linked=true" : ""}`,
    { method: "POST", token: as ?? token }
  );
}

function deleteMany(run: TestRun, body: unknown, { as }: { as?: string } = {}) {
  return api(`${runPath(run)}/files/delete`, {
    method: "POST",
    token: as ?? token,
    body,
  });
}

function restoreMany(
  run: TestRun,
  body: unknown,
  { as }: { as?: string } = {}
) {
  return api(`${runPath(run)}/files/restore`, {
    method: "POST",
    token: as ?? token,
    body,
  });
}

function linkedFor(
  run: TestRun,
  ids: string,
  { mode, as }: { mode?: string; as?: string } = {}
) {
  const query = new URLSearchParams({ file_ids: ids });
  if (mode) {
    query.set("for", mode);
  }
  return api(`${runPath(run)}/files/linked?${query}`, {
    token: as ?? token,
  });
}

// A result of the batch routes, trimmed to what each test reads.
interface ResultLike {
  error?: { code: string; message: string; details?: Record<string, unknown> };
  filename: string | null;
  id: number;
  ok: boolean;
  status?: number;
}

describe("Deleting and restoring files over REST and MCP", () => {
  beforeAll(async () => {
    await resetDb();
    ({ token, tokenId } = await seedTestUser({ tokenName: "Delete Token" }));
    const person = await seedTestUser({ email: "person@example.com" });
    personId = person.userId;
    personCookie = await seedSessionCookie(personId);
    mcpToken = await getMcpAccessToken(personId);
    ({ token: readOnlyToken } = await seedTestUser({
      scopes: ["files:read", "runs:read"],
      email: "reader@example.com",
    }));
    ({ token: runsOnlyToken } = await seedTestUser({
      scopes: ["runs:delete"],
      email: "runs-only@example.com",
    }));
    await getTestDb().insert(instruments).values({
      id: instrumentId,
      displayName: "Delete Restore API",
      status: "active",
      instrumentType: "dishcam",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Token scope: every route needs files:delete
  // -------------------------------------------------------------------------

  describe("who can call the routes", () => {
    const calls = {
      "delete a file": (_run: TestRun, id: number, as: string) =>
        deleteFile(id, { as }),
      "restore a file": (_run: TestRun, id: number, as: string) =>
        restoreFile(id, { as }),
      "delete several files": (run: TestRun, id: number, as: string) =>
        deleteMany(run, { file_ids: [id] }, { as }),
      "restore several files": (run: TestRun, id: number, as: string) =>
        restoreMany(run, { file_ids: [id] }, { as }),
      "list linked files": (run: TestRun, id: number, as: string) =>
        linkedFor(run, String(id), { as }),
    };

    it.each(
      Object.entries(calls)
    )("refuses a token without files:delete: %s", async (_name, call) => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      for (const limited of [readOnlyToken, runsOnlyToken]) {
        const res = await call(run, file.id, limited);
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toMatch(
          /missing required scope: files:delete/
        );
      }
      expect(await isDeleted(file.id)).toBe(false);
    });

    it("refuses a request with no credentials", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      const res = await api(`${runPath(run)}/files/delete`, {
        method: "POST",
        body: { file_ids: [file.id] },
      });

      expect(res.status).toBe(401);
      expect(await isDeleted(file.id)).toBe(false);
    });

    it("lets a signed-in person delete, restore and list linked files, and records them", async () => {
      const { run, one, sidecarA, outputs } = await seedCaptures();

      const linked = await api(
        `${runPath(run)}/files/linked?file_ids=${one.id}`,
        { headers: { Cookie: personCookie } }
      );
      expect(linked.status).toBe(200);

      const deleted = await api(`${runPath(run)}/files/delete`, {
        method: "POST",
        headers: { Cookie: personCookie },
        body: { file_ids: [one.id] },
      });
      expect(deleted.status).toBe(200);
      const body = runFilesDeleted.parse(await deleted.json());
      expect(body.results[0]).toMatchObject({
        ok: true,
        deleted_by: personId,
        deleted_by_token: null,
      });
      const row = await readFile(one.id);
      expect(row.deletedBy).toBe(personId);
      expect(row.deletedByToken).toBeNull();
      // Deleting only the file asked for leaves the rest of its folder.
      expect(await isDeleted(sidecarA.id)).toBe(false);
      expect(await isDeleted(outputs["sample_1.mp4"].id)).toBe(false);

      const restored = await api(`${runPath(run)}/files/restore`, {
        method: "POST",
        headers: { Cookie: personCookie },
        body: { file_ids: [one.id] },
      });
      expect(restored.status).toBe(200);
      expect(await isDeleted(one.id)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /files/:id
  // -------------------------------------------------------------------------

  describe("DELETE /files/:id", () => {
    it("deletes only the file by default, and lists no linked files", async () => {
      const { three, sidecarB, outputs } = await seedCaptures();

      const res = await deleteFile(three.id);

      expect(res.status).toBe(200);
      const body = fileDeleted.parse(await res.json());
      expect(body).toMatchObject({
        id: three.id,
        filename: "sample_3.tif",
        already_applied: false,
        linked: [],
      });
      expect(await isDeleted(three.id)).toBe(true);
      expect(await isDeleted(sidecarB.id)).toBe(false);
      expect(await isDeleted(outputs["sample_3.mp4"].id)).toBe(false);
    });

    it("with include_linked=true deletes the files made from it, and its sidecar, and lists them", async () => {
      const { three, sidecarB, outputs } = await seedCaptures();

      const res = await deleteFile(three.id, { linked: true });

      expect(res.status).toBe(200);
      const body = fileDeleted.parse(await res.json());
      // The linked files come in the order of their IDs.
      expect(
        body.linked.map(({ id, relation, filename }) => ({
          id,
          relation,
          filename,
        }))
      ).toEqual(
        [
          {
            id: outputs["sample_3.mp4"].id,
            relation: "video",
            filename: "sample_3.mp4",
          },
          {
            id: outputs["sample_3.jpg"].id,
            relation: "preview_image",
            filename: "sample_3.jpg",
          },
          { id: sidecarB.id, relation: "sidecar", filename: sidecarB.filename },
        ].sort((a, b) => a.id - b.id)
      );
      for (const file of body.linked) {
        expect(file.deleted_at).toBe(body.deleted_at);
        expect(await isDeleted(file.id)).toBe(true);
      }
    });

    it("keeps the sidecar while another raw file in its folder stays", async () => {
      const { one, sidecarA, outputs } = await seedCaptures();

      const body = fileDeleted.parse(
        await (await deleteFile(one.id, { linked: true })).json()
      );

      expect(body.linked.map((file) => file.id).sort()).toEqual(
        [outputs["sample_1.mp4"].id, outputs["sample_1.jpg"].id].sort()
      );
      expect(await isDeleted(sidecarA.id)).toBe(false);
    });

    it("names the token that deleted a file, the way a deleted run does", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      const body = fileDeleted.parse(await (await deleteFile(file.id)).json());

      expect(body.deleted_by).toBeNull();
      expect(body.deleted_by_token).toEqual({
        id: tokenId,
        name: "Delete Token",
      });
    });

    it("names the person who deleted a file, by user ID", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      const res = await api(`/api/v1/files/${file.id}`, {
        method: "DELETE",
        headers: { Cookie: personCookie },
      });

      const body = fileDeleted.parse(await res.json());
      expect(body.deleted_by).toBe(personId);
      expect(body.deleted_by_token).toBeNull();
    });

    it("answers a second delete with the first one's time and deleter", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      const first = fileDeleted.parse(
        await (
          await api(`/api/v1/files/${file.id}`, {
            method: "DELETE",
            headers: { Cookie: personCookie },
          })
        ).json()
      );

      const second = fileDeleted.parse(
        await (await deleteFile(file.id)).json()
      );

      expect(second.already_applied).toBe(true);
      expect(second.deleted_at).toBe(first.deleted_at);
      expect(second.deleted_by).toBe(personId);
      expect(second.deleted_by_token).toBeNull();
    });

    it("names a token that deleted a file earlier when the file is deleted again", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      await deleteFile(file.id);

      const body = fileDeleted.parse(await (await deleteFile(file.id)).json());

      expect(body.already_applied).toBe(true);
      expect(body.deleted_by_token).toEqual({
        id: tokenId,
        name: "Delete Token",
      });
    });

    it("answers 404 for a file that doesn't exist and 400 for an ID that isn't a number", async () => {
      expect((await deleteFile(999_999_999)).status).toBe(404);
      expect((await deleteFile(Number.NaN)).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /files/:id/restore
  // -------------------------------------------------------------------------

  describe("POST /files/:id/restore", () => {
    it("restores a deleted file and clears who deleted it", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      await deleteFile(file.id);

      const res = await restoreFile(file.id);

      expect(res.status).toBe(200);
      const body = fileRestored.parse(await res.json());
      expect(body).toMatchObject({
        id: file.id,
        filename: "a.tif",
        deleted_at: null,
        already_applied: false,
        linked: [],
      });
      const row = await readFile(file.id);
      expect(row.deletedAt).toBeNull();
      expect(row.deletedBy).toBeNull();
      expect(row.deletedByToken).toBeNull();
    });

    it("succeeds with already_applied for a file that isn't deleted", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");

      const res = await restoreFile(file.id);

      expect(res.status).toBe(200);
      expect(fileRestored.parse(await res.json()).already_applied).toBe(true);
    });

    it("refuses a file whose path another file now holds, naming that file", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      await deleteFile(file.id);
      // The watcher found a different file at the same path.
      const holder = await seedRaw(run, "a.tif", {
        status: "detected",
        s3Bucket: null,
        s3Key: null,
        uploadedAt: null,
      });

      const res = await restoreFile(file.id);

      expect(res.status).toBe(409);
      const { error } = await res.json();
      expect(error.code).toBe("CONFLICT");
      expect(error.message).toContain(`File ${holder.id} ('a.tif')`);
      expect(error.details).toMatchObject({
        reason: "path_in_use",
        held_by: { id: holder.id, filename: "a.tif" },
      });
      expect(await isDeleted(file.id)).toBe(true);
    });

    it("with include_linked=true restores the files that were deleted with it", async () => {
      const { three, sidecarB, outputs } = await seedCaptures();
      await deleteFile(three.id, { linked: true });

      const res = await restoreFile(three.id, { linked: true });

      expect(res.status).toBe(200);
      const body = fileRestored.parse(await res.json());
      expect(
        body.linked.map((file) => ({
          id: file.id,
          relation: file.relation,
          ok: file.ok,
        }))
      ).toEqual(
        [
          { id: outputs["sample_3.mp4"].id, relation: "video", ok: true },
          {
            id: outputs["sample_3.jpg"].id,
            relation: "preview_image",
            ok: true,
          },
          { id: sidecarB.id, relation: "sidecar", ok: true },
        ].sort((a, b) => a.id - b.id)
      );
      expect(await isDeleted(three.id)).toBe(false);
      expect(await isDeleted(sidecarB.id)).toBe(false);
      expect(await isDeleted(outputs["sample_3.mp4"].id)).toBe(false);
    });

    it("restores only the file by default", async () => {
      const { three, outputs } = await seedCaptures();
      await deleteFile(three.id, { linked: true });

      const body = fileRestored.parse(
        await (await restoreFile(three.id)).json()
      );

      expect(body.linked).toEqual([]);
      expect(await isDeleted(three.id)).toBe(false);
      expect(await isDeleted(outputs["sample_3.mp4"].id)).toBe(true);
    });

    it("brings back a raw file with a processed file that was made from it, and says so", async () => {
      const { three, outputs } = await seedCaptures();
      await deleteFile(three.id, { linked: true });

      const body = fileRestored.parse(
        await (
          await restoreFile(outputs["sample_3.mp4"].id, { linked: true })
        ).json()
      );

      expect(body.linked).toEqual([
        expect.objectContaining({
          id: three.id,
          relation: "made_from",
          ok: true,
        }),
      ]);
      expect(await isDeleted(three.id)).toBe(false);
    });

    it("reports a linked file that can't come back and still restores the others", async () => {
      const { run, three, outputs } = await seedCaptures();
      await deleteFile(three.id, { linked: true });
      const holder = await seedProcessed(run, "sample_3.jpg", null, {
        s3Key: null,
        s3Bucket: null,
        status: "detected",
      });

      const res = await restoreFile(three.id, { linked: true });

      expect(res.status).toBe(200);
      const body = fileRestored.parse(await res.json());
      expect(body.deleted_at).toBeNull();
      expect(await isDeleted(three.id)).toBe(false);
      const image = body.linked.find(
        (file) => file.id === outputs["sample_3.jpg"].id
      );
      expect(image).toMatchObject({
        ok: false,
        status: 409,
        relation: "preview_image",
        error: {
          code: "CONFLICT",
          details: {
            reason: "path_in_use",
            held_by: { id: holder.id },
          },
        },
      });
      expect(await isDeleted(outputs["sample_3.jpg"].id)).toBe(true);
      expect(await isDeleted(outputs["sample_3.mp4"].id)).toBe(false);
    });

    it("refuses a file of a deleted run", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      await deleteFile(file.id);
      await getTestDb()
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, run.id));

      const res = await restoreFile(file.id);

      expect(res.status).toBe(409);
      expect((await res.json()).error.details.reason).toBe("run_deleted");
      expect(await isDeleted(file.id)).toBe(true);
    });

    it("answers 404 for a file that doesn't exist and 400 for an ID that isn't a number", async () => {
      expect((await restoreFile(999_999_999)).status).toBe(404);
      expect((await restoreFile(Number.NaN)).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST .../files/delete
  // -------------------------------------------------------------------------

  describe("POST .../files/delete", () => {
    it("answers one result per file in the order sent, with each failure in place", async () => {
      const run = await seedRun();
      const other = await seedRun();
      const fine = await seedRaw(run, "fine.tif");
      const busy = await seedRaw(run, "busy.tif", {
        status: "processing",
        processingStartedAt: new Date(),
      });
      const queued = await seedRaw(run, "queued.tif", {
        status: "queued",
        queuedAt: new Date(),
      });
      const already = await seedRaw(run, "already.tif");
      await deleteFile(already.id);
      const elsewhere = await seedRaw(other, "elsewhere.tif");
      const missing = 999_999_999;

      const res = await deleteMany(run, {
        file_ids: [
          fine.id,
          busy.id,
          elsewhere.id,
          missing,
          already.id,
          fine.id,
          queued.id,
        ],
      });

      expect(res.status).toBe(200);
      const body = runFilesDeleted.parse(await res.json());
      expect(body.instrument_id).toBe(instrumentId);
      expect(body.run_id).toBe(run.runId);
      // The repeat of `fine` is dropped.
      expect(body.results.map((result) => result.id)).toEqual([
        fine.id,
        busy.id,
        elsewhere.id,
        missing,
        already.id,
        queued.id,
      ]);
      const [okResult, busyResult, elsewhereResult, missingResult] =
        body.results as ResultLike[];
      expect(okResult).toMatchObject({
        ok: true,
        filename: "fine.tif",
        already_applied: false,
        deleted_by: null,
        deleted_by_token: { id: tokenId, name: "Delete Token" },
      });
      expect(busyResult).toMatchObject({
        ok: false,
        status: 409,
        filename: "busy.tif",
        error: {
          code: "CONFLICT",
          details: { reason: "file_processing", status: "processing" },
        },
      });
      // A file of another run is not found in this one.
      expect(elsewhereResult).toMatchObject({
        ok: false,
        status: 404,
        filename: null,
        error: { code: "NOT_FOUND" },
      });
      expect(missingResult).toMatchObject({ ok: false, status: 404 });
      expect(body.results[4]).toMatchObject({
        ok: true,
        id: already.id,
        already_applied: true,
      });
      expect(body.results[5]).toMatchObject({
        ok: false,
        id: queued.id,
        status: 409,
      });
      expect(body.counts).toEqual({
        deleted: 1,
        already_deleted: 1,
        failed: 4,
      });
      expect(body.linked).toEqual([]);

      expect(await isDeleted(fine.id)).toBe(true);
      expect(await isDeleted(busy.id)).toBe(false);
      expect(await isDeleted(queued.id)).toBe(false);
      expect(await isDeleted(elsewhere.id)).toBe(false);
    });

    it("deletes the linked files too with include_linked, and lists them", async () => {
      const { run, one, two, sidecarA, outputs } = await seedCaptures();

      const res = await deleteMany(run, {
        file_ids: [one.id, two.id],
        include_linked: true,
      });

      const body = runFilesDeleted.parse(await res.json());
      expect(body.counts).toEqual({
        deleted: 2,
        already_deleted: 0,
        failed: 0,
      });
      // Both raw files of the folder go, so the sidecar they share goes once.
      expect(body.linked.map((file) => file.id).sort()).toEqual(
        [
          outputs["sample_1.mp4"].id,
          outputs["sample_1.jpg"].id,
          outputs["sample_2.mp4"].id,
          outputs["sample_2.jpg"].id,
          sidecarA.id,
        ].sort()
      );
      expect(
        body.linked.find((file) => file.id === sidecarA.id)?.relation
      ).toBe("sidecar");
      for (const file of body.linked) {
        expect(await isDeleted(file.id)).toBe(true);
      }
    });

    it("deletes only the files named when include_linked is left out or false", async () => {
      const { run, one, outputs } = await seedCaptures();

      for (const body of [
        { file_ids: [one.id] },
        { file_ids: [one.id], include_linked: false },
      ]) {
        const res = await deleteMany(run, body);
        expect(runFilesDeleted.parse(await res.json()).linked).toEqual([]);
      }
      expect(await isDeleted(outputs["sample_1.mp4"].id)).toBe(false);
    });

    it("answers a deleted run with a 409 result for each file, and deletes nothing", async () => {
      const run = await seedRun();
      const a = await seedRaw(run, "a.tif");
      const b = await seedRaw(run, "b.tif");
      await getTestDb()
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, run.id));

      const res = await deleteMany(run, { file_ids: [a.id, b.id] });

      expect(res.status).toBe(200);
      const body = runFilesDeleted.parse(await res.json());
      expect(body.results).toHaveLength(2);
      for (const result of body.results as ResultLike[]) {
        expect(result).toMatchObject({
          ok: false,
          status: 409,
          error: { details: { reason: "run_deleted" } },
        });
      }
      expect(body.counts.failed).toBe(2);
      expect(await isDeleted(a.id)).toBe(false);
    });

    it("answers 404 when the run doesn't exist", async () => {
      const res = await api(
        `/api/v1/instruments/${instrumentId}/runs/no-such-run/files/delete`,
        { method: "POST", token, body: { file_ids: [1] } }
      );

      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    });

    it("reads a run ID that has characters a URL treats specially", async () => {
      const run = await seedRun("odd %41 #1 name");
      const file = await seedRaw(run, "a.tif");

      const res = await deleteMany(run, { file_ids: [file.id] });

      expect(res.status).toBe(200);
      expect(runFilesDeleted.parse(await res.json())).toMatchObject({
        run_id: run.runId,
        counts: { deleted: 1 },
      });
    });

    it("takes 100 file IDs and refuses 101", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      const ids = Array.from({ length: 100 }, (_, i) => 900_000_000 + i);

      const ok = await deleteMany(run, {
        file_ids: [file.id, ...ids.slice(1)],
      });
      expect(ok.status).toBe(200);
      const body = runFilesDeleted.parse(await ok.json());
      expect(body.results).toHaveLength(100);
      expect(body.counts).toEqual({
        deleted: 1,
        already_deleted: 0,
        failed: 99,
      });

      const other = await seedRaw(run, "b.tif");
      const tooMany = await deleteMany(run, {
        file_ids: [other.id, ...Array.from({ length: 100 }, (_, i) => i + 1)],
      });
      expect(tooMany.status).toBe(400);
      expect((await tooMany.json()).error.code).toBe("VALIDATION_ERROR");
      expect(await isDeleted(other.id)).toBe(false);
    });

    it.each([
      ["no file IDs", { file_ids: [] }],
      ["no file_ids", {}],
      ["an ID that isn't a number", { file_ids: ["12"] }],
      ["an ID that isn't a whole number", { file_ids: [1.5] }],
      ["an ID of zero", { file_ids: [0] }],
      ["a negative ID", { file_ids: [-3] }],
      [
        "include_linked that isn't a boolean",
        { file_ids: [1], include_linked: "yes" },
      ],
    ])("refuses %s", async (_name, body) => {
      const run = await seedRun();
      const res = await deleteMany(run, body);

      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("refuses a body that isn't JSON", async () => {
      const run = await seedRun();
      const res = await fetch(
        `${process.env.__TEST_BASE_URL}${runPath(run)}/files/delete`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: "{not json",
        }
      );

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST .../files/restore
  // -------------------------------------------------------------------------

  describe("POST .../files/restore", () => {
    it("answers one result per file, and a file that can't come back doesn't stop the others", async () => {
      const run = await seedRun();
      const other = await seedRun();
      const back = await seedRaw(run, "back.tif");
      const held = await seedRaw(run, "held.tif");
      const never = await seedRaw(run, "never.tif");
      const elsewhere = await seedRaw(other, "elsewhere.tif");
      await deleteFile(back.id);
      await deleteFile(held.id);
      await deleteFile(elsewhere.id);
      const holder = await seedRaw(run, "held.tif", {
        status: "detected",
        s3Bucket: null,
        s3Key: null,
        uploadedAt: null,
      });

      const res = await restoreMany(run, {
        file_ids: [back.id, held.id, never.id, elsewhere.id, back.id],
      });

      expect(res.status).toBe(200);
      const body = runFilesRestored.parse(await res.json());
      expect(body.results.map((result) => result.id)).toEqual([
        back.id,
        held.id,
        never.id,
        elsewhere.id,
      ]);
      const [okResult, heldResult, neverResult, elsewhereResult] =
        body.results as ResultLike[];
      expect(okResult).toMatchObject({
        ok: true,
        filename: "back.tif",
        deleted_at: null,
        already_applied: false,
      });
      expect(heldResult).toMatchObject({
        ok: false,
        status: 409,
        filename: "held.tif",
        error: {
          code: "CONFLICT",
          details: {
            reason: "path_in_use",
            held_by: { id: holder.id, filename: "held.tif" },
          },
        },
      });
      expect(heldResult.error?.message).toContain(`File ${holder.id}`);
      expect(neverResult).toMatchObject({ ok: true, already_applied: true });
      expect(elsewhereResult).toMatchObject({
        ok: false,
        status: 404,
        filename: null,
      });
      expect(body.counts).toEqual({
        restored: 1,
        already_restored: 1,
        failed: 2,
      });
      expect(await isDeleted(back.id)).toBe(false);
      expect(await isDeleted(held.id)).toBe(true);
      // The other run's deleted file stays deleted.
      expect(await isDeleted(elsewhere.id)).toBe(true);
    });

    it("restores the linked files too with include_linked, each with its own result", async () => {
      const { run, one, two, sidecarA, outputs } = await seedCaptures();
      await deleteMany(run, {
        file_ids: [one.id, two.id],
        include_linked: true,
      });

      const res = await restoreMany(run, {
        file_ids: [one.id],
        include_linked: true,
      });

      const body = runFilesRestored.parse(await res.json());
      expect(body.counts).toEqual({
        restored: 1,
        already_restored: 0,
        failed: 0,
      });
      // The sidecar comes back with any raw file of its folder. The other
      // raw file and its outputs stay deleted.
      expect(body.linked.map((file) => file.id).sort()).toEqual(
        [
          outputs["sample_1.mp4"].id,
          outputs["sample_1.jpg"].id,
          sidecarA.id,
        ].sort()
      );
      expect(body.linked.every((file) => file.ok)).toBe(true);
      expect(await isDeleted(sidecarA.id)).toBe(false);
      expect(await isDeleted(two.id)).toBe(true);
      expect(await isDeleted(outputs["sample_2.mp4"].id)).toBe(true);
    });

    it("restores only the files named without include_linked", async () => {
      const { run, one, outputs } = await seedCaptures();
      await deleteMany(run, { file_ids: [one.id], include_linked: true });

      const body = runFilesRestored.parse(
        await (await restoreMany(run, { file_ids: [one.id] })).json()
      );

      expect(body.linked).toEqual([]);
      expect(await isDeleted(outputs["sample_1.mp4"].id)).toBe(true);
    });

    it("answers a deleted run with a 409 result for each file", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      await deleteFile(file.id);
      await getTestDb()
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, run.id));

      const res = await restoreMany(run, { file_ids: [file.id] });

      expect(res.status).toBe(200);
      const body = runFilesRestored.parse(await res.json());
      expect(body.results[0]).toMatchObject({
        ok: false,
        status: 409,
        error: { details: { reason: "run_deleted" } },
      });
      expect(await isDeleted(file.id)).toBe(true);
    });

    it("answers 404 when the run doesn't exist, and 400 for 0 or 101 IDs", async () => {
      const missing = await api(
        `/api/v1/instruments/${instrumentId}/runs/no-such-run/files/restore`,
        { method: "POST", token, body: { file_ids: [1] } }
      );
      expect(missing.status).toBe(404);

      const run = await seedRun();
      expect((await restoreMany(run, { file_ids: [] })).status).toBe(400);
      expect(
        (
          await restoreMany(run, {
            file_ids: Array.from({ length: 101 }, (_, i) => i + 1),
          })
        ).status
      ).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // GET .../files/linked
  // -------------------------------------------------------------------------

  describe("GET .../files/linked", () => {
    it("groups what a delete would take by the file asked about", async () => {
      const { run, one, three, sidecarB, outputs } = await seedCaptures();

      const res = await linkedFor(run, `${three.id},${one.id}`);

      expect(res.status).toBe(200);
      const body = runFilesLinked.parse(await res.json());
      expect(body.instrument_id).toBe(instrumentId);
      expect(body.run_id).toBe(run.runId);
      const byFile = new Map(
        body.groups.map((group) => [group.file_id, group.linked])
      );
      // `sample_3` is alone in its folder, so its sidecar is offered. The
      // folder of `sample_1` holds `sample_2` too, so its sidecar is not.
      expect(byFile.get(three.id)).toEqual([
        {
          id: outputs["sample_3.mp4"].id,
          filename: "sample_3.mp4",
          size_bytes: 1000,
          category: "processed",
          relation: "video",
          deleted_at: null,
        },
        {
          id: outputs["sample_3.jpg"].id,
          filename: "sample_3.jpg",
          size_bytes: 50,
          category: "processed",
          relation: "preview_image",
          deleted_at: null,
        },
        {
          id: sidecarB.id,
          filename: "run~0a1b2c3d.json",
          size_bytes: 10,
          category: "raw",
          relation: "sidecar",
          deleted_at: null,
        },
      ]);
      expect(byFile.get(one.id)?.map((file) => file.relation)).toEqual([
        "video",
        "preview_image",
      ]);
    });

    it("offers a shared sidecar under each raw file when every raw file of the folder is asked about", async () => {
      const { run, one, two, sidecarA } = await seedCaptures();

      const body = runFilesLinked.parse(
        await (await linkedFor(run, `${one.id},${two.id}`)).json()
      );

      for (const group of body.groups) {
        expect(group.linked.map((file) => file.id)).toContain(sidecarA.id);
      }
    });

    it("lists the deleted counterparts for a restore, with the file a processed file was made from", async () => {
      const { run, one, three, outputs } = await seedCaptures();
      await deleteMany(run, {
        file_ids: [one.id, three.id],
        include_linked: true,
      });

      const forRaw = runFilesLinked.parse(
        await (await linkedFor(run, String(one.id), { mode: "restore" })).json()
      );
      expect(forRaw.groups).toHaveLength(1);
      expect(forRaw.groups[0].linked.map((file) => file.relation)).toEqual([
        "video",
        "preview_image",
      ]);
      for (const file of forRaw.groups[0].linked) {
        expect(file.deleted_at).not.toBeNull();
      }

      const forProcessed = runFilesLinked.parse(
        await (
          await linkedFor(run, String(outputs["sample_3.mp4"].id), {
            mode: "restore",
          })
        ).json()
      );
      expect(forProcessed.groups).toEqual([
        {
          file_id: outputs["sample_3.mp4"].id,
          linked: [
            expect.objectContaining({ id: three.id, relation: "made_from" }),
          ],
        },
      ]);
    });

    it("lists nothing for a file with no linked files, and leaves out files of other runs", async () => {
      const { run, one } = await seedCaptures();
      const other = await seedRun();
      const alone = await seedRaw(run, "alone.tif");
      const elsewhere = await seedRaw(other, "elsewhere.tif");
      await seedProcessed(other, "elsewhere.mp4", elsewhere.id);

      const body = runFilesLinked.parse(
        await (
          await linkedFor(
            run,
            `${alone.id},${elsewhere.id},999999999,${one.id}`
          )
        ).json()
      );

      expect(body.groups.map((group) => group.file_id)).toEqual([one.id]);
    });

    it("changes nothing", async () => {
      const { run, one, three } = await seedCaptures();
      const before = await getTestDb()
        .select()
        .from(files)
        .where(eq(files.instrumentRunId, run.id))
        .orderBy(files.id);

      await linkedFor(run, `${one.id},${three.id}`);
      await linkedFor(run, `${one.id},${three.id}`, { mode: "restore" });

      expect(
        await getTestDb()
          .select()
          .from(files)
          .where(eq(files.instrumentRunId, run.id))
          .orderBy(files.id)
      ).toEqual(before);
    });

    it.each([
      ["file_ids left out", ""],
      ["a file ID that isn't a number", "abc"],
      ["a file ID of zero", "0"],
      ["a decimal file ID", "1.5"],
      ["a list with an empty entry", "1,,2"],
      ["a file ID too large to be exact", "99999999999999999999"],
    ])("refuses %s", async (_name, ids) => {
      const run = await seedRun();
      const res = await linkedFor(run, ids);

      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("takes 100 file IDs, refuses 101, and refuses a `for` it doesn't know", async () => {
      const run = await seedRun();
      const ids = (count: number) =>
        Array.from({ length: count }, (_, i) => i + 1).join(",");

      expect((await linkedFor(run, ids(100))).status).toBe(200);
      expect((await linkedFor(run, ids(101))).status).toBe(400);
      const sideways = await linkedFor(run, "1", { mode: "sideways" });
      expect(sideways.status).toBe(400);
      expect((await sideways.json()).error.message).toContain(
        "delete or restore"
      );
    });

    it("answers 404 when the run doesn't exist", async () => {
      const res = await api(
        `/api/v1/instruments/${instrumentId}/runs/no-such-run/files/linked?file_ids=1`,
        { token }
      );

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET run detail
  // -------------------------------------------------------------------------

  describe("GET run detail", () => {
    async function seedDeletedAndActive() {
      const run = await seedRun();
      const active = await seedRaw(run, "active.tif");
      const byToken = await seedRaw(run, "by-token.tif");
      const byPerson = await seedRaw(run, "by-person.tif");
      await deleteFile(byToken.id);
      await api(`/api/v1/files/${byPerson.id}`, {
        method: "DELETE",
        headers: { Cookie: personCookie },
      });
      return { run, active, byToken, byPerson };
    }

    it("leaves deleted files out by default and with include_deleted=false", async () => {
      const { run, active } = await seedDeletedAndActive();

      for (const query of ["", "?include_deleted=false"]) {
        const res = await api(`${runPath(run)}${query}`, { token });
        expect(res.status).toBe(200);
        const body = runDetail.parse(await res.json());
        expect(body.files.map((file) => file.id)).toEqual([active.id]);
      }
    });

    it("lists deleted files with include_deleted=true, and names who deleted each", async () => {
      const { run, active, byToken, byPerson } = await seedDeletedAndActive();

      const res = await api(`${runPath(run)}?include_deleted=true`, { token });

      expect(res.status).toBe(200);
      const body = runDetail.parse(await res.json());
      const byId = new Map(body.files.map((file) => [file.id, file]));
      expect([...byId.keys()].sort()).toEqual(
        [active.id, byToken.id, byPerson.id].sort()
      );
      expect(byId.get(active.id)).toMatchObject({
        deleted_at: null,
        deleted_by: null,
        deleted_by_token: null,
      });
      expect(byId.get(byToken.id)).toMatchObject({
        deleted_by: null,
        deleted_by_token: { id: tokenId, name: "Delete Token" },
      });
      expect(byId.get(byToken.id)?.deleted_at).toBeTruthy();
      expect(byId.get(byPerson.id)).toMatchObject({
        deleted_by: personId,
        deleted_by_token: null,
      });
    });

    it("reads the deleter of a file deleted before Data Hub recorded who did it as empty", async () => {
      const run = await seedRun();
      const old = await seedRaw(run, "old.tif", { deletedAt: new Date() });

      const body = runDetail.parse(
        await (
          await api(`${runPath(run)}?include_deleted=true`, { token })
        ).json()
      );

      expect(body.files).toEqual([
        expect.objectContaining({
          id: old.id,
          deleted_by: null,
          deleted_by_token: null,
        }),
      ]);
    });

    it("shows a restored file as active again", async () => {
      const { run, byToken } = await seedDeletedAndActive();
      await restoreFile(byToken.id);

      const body = runDetail.parse(
        await (await api(runPath(run), { token })).json()
      );

      expect(body.files.map((file) => file.id)).toContain(byToken.id);
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
        structured: result.structuredContent,
      };
    }

    it("delete_files deletes files and, with includeLinked, their linked files, as the signed-in user", async () => {
      const { run, three, sidecarB, outputs } = await seedCaptures();

      const result = await callTool("delete_files", {
        instrumentId,
        runId: run.runId,
        fileIds: [three.id],
        includeLinked: true,
      });

      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.text);
      expect(body).toMatchObject({
        instrumentId,
        runId: run.runId,
        counts: { deleted: 1, alreadyDeleted: 0, failed: 0 },
      });
      expect(body.results[0]).toMatchObject({
        ok: true,
        id: three.id,
        filename: "sample_3.tif",
        deletedBy: personId,
        deletedByToken: null,
        alreadyApplied: false,
      });
      expect(
        body.linked.map((file: { id: number; relation: string }) => [
          file.id,
          file.relation,
        ])
      ).toEqual(
        [
          [outputs["sample_3.mp4"].id, "video"],
          [outputs["sample_3.jpg"].id, "preview_image"],
          [sidecarB.id, "sidecar"],
        ].sort((a, b) => (a[0] as number) - (b[0] as number))
      );
      expect(result.structured).toEqual(body);
      const row = await readFile(three.id);
      expect(row.deletedBy).toBe(personId);
      expect(row.deletedByToken).toBeNull();
      expect(await isDeleted(sidecarB.id)).toBe(true);
    });

    it("delete_files deletes only the files named when includeLinked is left out or false", async () => {
      const { run, one, two, three, sidecarB, outputs } = await seedCaptures();

      for (const [ids, extra] of [
        [[three.id], {}],
        [[one.id, two.id], { includeLinked: false }],
      ] as const) {
        const result = await callTool("delete_files", {
          instrumentId,
          runId: run.runId,
          fileIds: ids,
          ...extra,
        });
        expect(JSON.parse(result.text).linked).toEqual([]);
      }
      expect(await isDeleted(three.id)).toBe(true);
      expect(await isDeleted(outputs["sample_3.mp4"].id)).toBe(false);
      expect(await isDeleted(sidecarB.id)).toBe(false);
      expect(await isDeleted(outputs["sample_1.mp4"].id)).toBe(false);
    });

    it("delete_files reports each refused file in the result, not as an error", async () => {
      const run = await seedRun();
      const other = await seedRun();
      const fine = await seedRaw(run, "fine.tif");
      const busy = await seedRaw(run, "busy.tif", {
        status: "processing",
        processingStartedAt: new Date(),
      });
      const elsewhere = await seedRaw(other, "elsewhere.tif");

      const result = await callTool("delete_files", {
        instrumentId,
        runId: run.runId,
        fileIds: [fine.id, busy.id, elsewhere.id],
      });

      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.text);
      expect(body.counts).toEqual({
        deleted: 1,
        alreadyDeleted: 0,
        failed: 2,
      });
      expect(body.results[1]).toMatchObject({
        ok: false,
        id: busy.id,
        status: 409,
        error: {
          code: "CONFLICT",
          message: expect.stringContaining("Wait for processing to finish"),
          details: { reason: "file_processing" },
        },
      });
      expect(body.results[2]).toMatchObject({
        ok: false,
        id: elsewhere.id,
        status: 404,
        filename: null,
      });
      expect(await isDeleted(elsewhere.id)).toBe(false);
    });

    it("delete_files fails for a run that doesn't exist, and refuses 0 or 101 file IDs", async () => {
      const missing = await callTool("delete_files", {
        instrumentId,
        runId: "no-such-run",
        fileIds: [1],
      });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("Run 'no-such-run' not found");

      const run = await seedRun();
      for (const fileIds of [
        [],
        Array.from({ length: 101 }, (_, i) => i + 1),
      ]) {
        const refused = await callTool("delete_files", {
          instrumentId,
          runId: run.runId,
          fileIds,
        });
        expect(refused.isError).toBe(true);
      }
    });

    it("list_run_files leaves deleted files out until includeDeleted, then says who deleted each", async () => {
      const run = await seedRun();
      const active = await seedRaw(run, "active.tif");
      const byToken = await seedRaw(run, "by-token.tif");
      const byPerson = await seedRaw(run, "by-person.tif");
      await deleteFile(byToken.id);
      await callTool("delete_files", {
        instrumentId,
        runId: run.runId,
        fileIds: [byPerson.id],
      });

      const hidden = await callTool("list_run_files", {
        instrumentId,
        runId: run.runId,
      });
      expect(
        JSON.parse(hidden.text).data.map((file: { id: number }) => file.id)
      ).toEqual([active.id]);
      expect(JSON.parse(hidden.text).data[0]).toMatchObject({
        deletedAt: null,
        deletedBy: null,
        deletedByToken: null,
      });

      const shown = await callTool("list_run_files", {
        instrumentId,
        runId: run.runId,
        includeDeleted: true,
      });
      expect(shown.isError).toBeFalsy();
      const byId = new Map(
        JSON.parse(shown.text).data.map((file: { id: number }) => [
          file.id,
          file,
        ])
      );
      expect([...byId.keys()].sort()).toEqual(
        [active.id, byToken.id, byPerson.id].sort()
      );
      expect(byId.get(byToken.id)).toMatchObject({
        deletedBy: null,
        deletedByToken: { id: tokenId, name: "Delete Token" },
      });
      expect(
        (byId.get(byToken.id) as { deletedAt: string }).deletedAt
      ).toBeTruthy();
      expect(byId.get(byPerson.id)).toMatchObject({
        deletedBy: personId,
        deletedByToken: null,
      });
    });

    it("restore_files brings files back with includeLinked, with their linked files, and reports a refused file in the result", async () => {
      const { run, three, sidecarB, outputs } = await seedCaptures();
      await callTool("delete_files", {
        instrumentId,
        runId: run.runId,
        fileIds: [three.id],
        includeLinked: true,
      });
      const holder = await seedProcessed(run, "sample_3.mp4", null, {
        s3Key: null,
        s3Bucket: null,
        status: "detected",
      });

      const result = await callTool("restore_files", {
        instrumentId,
        runId: run.runId,
        fileIds: [three.id],
        includeLinked: true,
      });

      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.text);
      expect(body.counts).toEqual({
        restored: 1,
        alreadyRestored: 0,
        failed: 0,
      });
      expect(result.structured).toEqual(body);
      const video = body.linked.find(
        (file: { id: number }) => file.id === outputs["sample_3.mp4"].id
      );
      expect(video).toMatchObject({
        ok: false,
        status: 409,
        relation: "video",
        error: {
          details: { reason: "path_in_use", held_by: { id: holder.id } },
        },
      });
      expect(await isDeleted(three.id)).toBe(false);
      expect(await isDeleted(sidecarB.id)).toBe(false);
      expect(await isDeleted(outputs["sample_3.jpg"].id)).toBe(false);
      expect(await isDeleted(outputs["sample_3.mp4"].id)).toBe(true);
    });

    it("restore_files restores only the files named when includeLinked is left out or false", async () => {
      const { run, one, three, outputs } = await seedCaptures();
      await deleteMany(run, {
        file_ids: [one.id, three.id],
        include_linked: true,
      });

      for (const [id, extra] of [
        [three.id, {}],
        [one.id, { includeLinked: false }],
      ] as const) {
        const result = await callTool("restore_files", {
          instrumentId,
          runId: run.runId,
          fileIds: [id],
          ...extra,
        });
        expect(JSON.parse(result.text).linked).toEqual([]);
        expect(await isDeleted(id)).toBe(false);
      }
      expect(await isDeleted(outputs["sample_3.mp4"].id)).toBe(true);
      expect(await isDeleted(outputs["sample_1.mp4"].id)).toBe(true);
    });

    it("get_file returns a deleted file, saying when and by whom", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      await deleteFile(file.id);

      const result = await callTool("get_file", { fileId: file.id });

      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.text);
      expect(body).toMatchObject({
        id: file.id,
        filename: "a.tif",
        deletedBy: null,
        deletedByToken: { id: tokenId, name: "Delete Token" },
      });
      expect(body.deletedAt).toBeTruthy();
      expect(result.structured).toEqual(body);

      await restoreFile(file.id);
      expect(
        JSON.parse((await callTool("get_file", { fileId: file.id })).text)
      ).toMatchObject({
        deletedAt: null,
        deletedBy: null,
        deletedByToken: null,
      });
    });

    it("dismiss_file still deletes one file, says it is deprecated, and names delete_files", async () => {
      const run = await seedRun();
      const file = await seedRaw(run, "a.tif");
      const other = await seedRaw(run, "b.tif");
      const video = await seedProcessed(run, "a.mp4", file.id);

      const deleted = await callTool("dismiss_file", { fileId: file.id });

      expect(deleted.isError).toBeFalsy();
      expect(JSON.parse(deleted.text)).toMatchObject({
        id: file.id,
        alreadyApplied: false,
      });
      expect((await readFile(file.id)).deletedBy).toBe(personId);
      // It never took the files linked to the one it deleted.
      expect(await isDeleted(video.id)).toBe(false);
      expect(await isDeleted(other.id)).toBe(false);

      const list = await api("/mcp/v1", {
        method: "POST",
        token: mcpToken,
        headers: { Accept: "application/json, text/event-stream" },
        body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      });
      const text = await list.text();
      const line = text.split("\n").find((l) => l.startsWith("data: "));
      const tools = JSON.parse((line ?? "").slice("data: ".length)).result
        .tools as { name: string; description: string }[];
      const description = tools.find(
        (tool) => tool.name === "dismiss_file"
      )?.description;
      expect(description).toMatch(/^Deprecated: use delete_files/);
    });
  });
});
