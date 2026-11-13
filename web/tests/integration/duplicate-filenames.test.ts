import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taggedFilename } from "@/lib/api/run-file-identity";
import { WATCHER_VERSION_HEADER } from "@/lib/api/watcher-compat";
import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

const instrumentId = "duplicate-filename-instrument";
const watcherHeaders = { [WATCHER_VERSION_HEADER]: "1.1.0" };

describe("same-named files from different folders", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
    await getTestDb().insert(instruments).values({
      id: instrumentId,
      displayName: "Duplicate Filename Instrument",
      status: "active",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("stores a plain name and a tagged name when a new watcher reports both folders", async () => {
    const runId = "tagged-across-reports";
    const first = {
      relative_path: "alice/day-1/capture-a/sample.tif",
      filename: "sample.tif",
      size_bytes: 10,
      file_created_at: "2026-08-21T18:00:00.000Z",
    };
    const second = {
      relative_path: "alice/day-2/capture-b/sample.tif",
      filename: "sample.tif",
      size_bytes: 11,
      file_created_at: "2026-09-03T18:00:00.000Z",
    };

    const created = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      headers: watcherHeaders,
      body: { run_id: runId, source: "watcher", detected_files: [first] },
    });
    expect(created.status).toBe(201);

    const patched = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      {
        method: "PATCH",
        token,
        headers: watcherHeaders,
        body: { detected_files: [second] },
      }
    );
    expect(patched.status).toBe(200);

    const names = await filenames(runId);
    expect(names).toEqual([
      "sample.tif",
      taggedFilename("sample.tif", second.relative_path),
    ]);
  });

  it("tags the later file when one report contains both copies", async () => {
    const runId = "tagged-one-batch";
    const firstPath = "day-1/capture/stack.tif";
    const secondPath = "day-2/capture/stack.tif";
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      headers: watcherHeaders,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          {
            relative_path: firstPath,
            filename: "stack.tif",
            size_bytes: 1,
            file_created_at: "2026-09-01T00:00:00.000Z",
          },
          {
            relative_path: secondPath,
            filename: "stack.tif",
            size_bytes: 2,
            file_created_at: "2026-09-02T00:00:00.000Z",
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(await filenames(runId)).toEqual([
      "stack.tif",
      taggedFilename("stack.tif", secondPath),
    ]);
  });

  it("stores both files when name, size, and creation time match", async () => {
    const runId = "same-bytes";
    const createdAt = "2026-09-04T00:00:00.000Z";
    const backup = "backup/sample.tif";
    const tagged = taggedFilename("sample.tif", backup);
    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      headers: watcherHeaders,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          {
            relative_path: "original/sample.tif",
            filename: "sample.tif",
            size_bytes: 42,
            file_created_at: createdAt,
          },
        ],
      },
    });
    await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      method: "PATCH",
      token,
      headers: watcherHeaders,
      body: {
        detected_files: [
          {
            relative_path: backup,
            filename: "sample.tif",
            size_bytes: 42,
            file_created_at: createdAt,
          },
        ],
      },
    });
    expect(await filenames(runId)).toEqual(["sample.tif", tagged]);

    const first = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        headers: watcherHeaders,
        body: {
          filename: "sample.tif",
          relative_path: "original/sample.tif",
          size_bytes: 42,
          file_created_at: createdAt,
        },
      }
    );
    const firstBody = await first.json();
    await api(`/api/v1/files/${firstBody.file_id}`, {
      method: "PATCH",
      token,
      body: {
        status: "uploaded",
        content_type: "image/tiff",
      },
    });

    const upload = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        headers: watcherHeaders,
        body: {
          filename: "sample.tif",
          relative_path: backup,
          size_bytes: 42,
          file_created_at: createdAt,
        },
      }
    );
    expect(upload.status).toBe(200);
    const body = await upload.json();
    expect(body.already_uploaded).toBe(false);
    expect(body.file_id).not.toBe(firstBody.file_id);
    expect(body.s3_key).toBe(`${instrumentId}/${runId}/${tagged}`);
    expect(await filenames(runId)).toEqual(["sample.tif", tagged]);
  });

  it("leaves a re-report unchanged", async () => {
    const runId = "re-report";
    const file = {
      relative_path: "alice/day-2/capture-b/plate.tif",
      filename: "plate.tif",
      size_bytes: 5,
      file_created_at: "2026-09-03T18:00:00.000Z",
    };
    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      headers: watcherHeaders,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          {
            relative_path: "alice/day-1/capture-a/plate.tif",
            filename: "plate.tif",
            size_bytes: 4,
            file_created_at: "2026-08-21T18:00:00.000Z",
          },
          file,
        ],
      },
    });
    await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      method: "PATCH",
      token,
      headers: watcherHeaders,
      body: { detected_files: [file] },
    });
    expect(await filenames(runId)).toEqual([
      "plate.tif",
      taggedFilename("plate.tif", file.relative_path),
    ]);
  });

  it("returns the tagged S3 key when the new watcher asks to upload the later file", async () => {
    const runId = "tagged-upload";
    const later = "alice/day-2/capture-b/sample.tif";
    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      headers: watcherHeaders,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          {
            relative_path: "alice/day-1/capture-a/sample.tif",
            filename: "sample.tif",
            size_bytes: 10,
            file_created_at: "2026-08-21T18:00:00.000Z",
          },
          {
            relative_path: later,
            filename: "sample.tif",
            size_bytes: 11,
            file_created_at: "2026-09-03T18:00:00.000Z",
          },
        ],
      },
    });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        headers: watcherHeaders,
        body: {
          filename: "sample.tif",
          relative_path: later,
          content_type: "image/tiff",
          size_bytes: 11,
        },
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_uploaded).toBe(false);
    expect(body.s3_key).toBe(
      `${instrumentId}/${runId}/${taggedFilename("sample.tif", later)}`
    );
  });

  it("drops the later duplicate for a watcher that does not send a version", async () => {
    const runId = "legacy-drop";
    const created = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          {
            relative_path: "a/sample.tif",
            filename: "sample.tif",
            size_bytes: 1,
          },
          {
            relative_path: "b/sample.tif",
            filename: "sample.tif",
            size_bytes: 2,
          },
        ],
      },
    });
    expect(created.status).toBe(201);
    expect(await filenames(runId)).toEqual(["sample.tif"]);

    const upload = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: {
          filename: "sample.tif",
          relative_path: "b/sample.tif",
          size_bytes: 2,
        },
      }
    );
    const body = await upload.json();
    expect(body.s3_key).toBe(`${instrumentId}/${runId}/sample.tif`);
    expect(await filenames(runId)).toEqual(["sample.tif"]);
  });

  describe("a file at the path of a dismissed file", () => {
    interface RunFile {
      deleted_at: string | null;
      filename: string;
      id: number;
      relative_path: string | null;
      size_bytes: number | null;
      status: string;
    }

    const relativePath = "capture/sample.tif";
    const firstCreatedAt = "2026-09-21T17:00:00.123456+00:00";
    const laterCreatedAt = "2026-09-22T09:30:00.000000+00:00";

    function reported(
      sizeBytes: number,
      createdAt = firstCreatedAt,
      path = relativePath
    ) {
      return {
        relative_path: path,
        filename: path.slice(path.lastIndexOf("/") + 1),
        size_bytes: sizeBytes,
        file_created_at: createdAt,
      };
    }

    async function runFiles(runId: string): Promise<RunFile[]> {
      const detail = await api(
        `/api/v1/instruments/${instrumentId}/runs/${runId}`,
        { token }
      );
      const body = await detail.json();
      return body.files;
    }

    async function createRunWith(
      runId: string,
      file: ReturnType<typeof reported>,
      headers: Record<string, string> = watcherHeaders
    ) {
      const created = await api(`/api/v1/instruments/${instrumentId}/runs`, {
        method: "POST",
        token,
        headers,
        body: { run_id: runId, source: "watcher", detected_files: [file] },
      });
      expect(created.status).toBe(201);
    }

    // The way a watcher reports files for a run the server already has.
    async function report(
      runId: string,
      file: ReturnType<typeof reported>,
      headers: Record<string, string> = watcherHeaders
    ) {
      const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
        method: "POST",
        token,
        headers,
        body: { run_id: runId, source: "watcher", detected_files: [file] },
      });
      expect(res.status).toBe(200);
    }

    async function dismissAll(runId: string) {
      for (const file of await runFiles(runId)) {
        if (!file.deleted_at) {
          const res = await api(`/api/v1/files/${file.id}`, {
            method: "DELETE",
            token,
          });
          expect(res.status).toBe(200);
        }
      }
    }

    function requestUpload(
      runId: string,
      file: ReturnType<typeof reported>,
      headers: Record<string, string> = watcherHeaders
    ) {
      return api(
        `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
        {
          method: "POST",
          token,
          headers,
          body: file,
        }
      );
    }

    it("stores a different file a watcher reports there as a new detected row", async () => {
      const runId = "dismissed-path-report";
      await createRunWith(runId, reported(1));
      const [dismissed] = await runFiles(runId);
      await dismissAll(runId);

      await report(runId, reported(900, laterCreatedAt));

      const rows = await runFiles(runId);
      expect(rows).toHaveLength(2);
      const old = rows.find((row) => row.id === dismissed.id);
      expect(old?.deleted_at).toBeTruthy();
      expect(old?.size_bytes).toBe(1);
      const fresh = rows.find((row) => row.id !== dismissed.id);
      expect(fresh).toMatchObject({
        status: "detected",
        deleted_at: null,
        relative_path: relativePath,
        filename: "sample.tif",
        size_bytes: 900,
      });
    });

    it("stores a file with the same size and a later creation time as a new row", async () => {
      const runId = "dismissed-path-created-at";
      await createRunWith(runId, reported(5));
      await dismissAll(runId);

      await report(runId, reported(5, laterCreatedAt));

      const rows = await runFiles(runId);
      expect(rows.map((row) => row.deleted_at === null)).toEqual([false, true]);
    });

    it("keeps the same file dismissed when a watcher reports it again", async () => {
      const runId = "dismissed-path-same-file";
      await createRunWith(runId, reported(5));
      await dismissAll(runId);

      // The watcher sends microseconds. The stored time is in milliseconds.
      await report(runId, reported(5));
      const patched = await api(
        `/api/v1/instruments/${instrumentId}/runs/${runId}`,
        {
          method: "PATCH",
          token,
          headers: watcherHeaders,
          body: { detected_files: [reported(5)] },
        }
      );
      expect(patched.status).toBe(200);

      const rows = await runFiles(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deleted_at).toBeTruthy();
    });

    it("compares a report with every dismissed file at the path", async () => {
      const runId = "dismissed-path-several";
      await createRunWith(runId, reported(10));
      await dismissAll(runId);
      await report(runId, reported(20, laterCreatedAt));
      await dismissAll(runId);

      // Both earlier files stay dismissed. A third one is new.
      await report(runId, reported(10));
      await report(runId, reported(20, laterCreatedAt));
      expect(await runFiles(runId)).toHaveLength(2);

      await report(runId, reported(30, "2026-09-23T08:00:00.000000+00:00"));
      const rows = await runFiles(runId);
      expect(
        rows.map((row) => [row.size_bytes, row.deleted_at === null])
      ).toEqual([
        [10, false],
        [20, false],
        [30, true],
      ]);
    });

    it("reports a different file at the path through the run update too", async () => {
      const runId = "dismissed-path-patch";
      await createRunWith(runId, reported(1));
      await dismissAll(runId);

      const patched = await api(
        `/api/v1/instruments/${instrumentId}/runs/${runId}`,
        {
          method: "PATCH",
          token,
          headers: watcherHeaders,
          body: { detected_files: [reported(2, laterCreatedAt)] },
        }
      );
      expect(patched.status).toBe(200);

      const rows = await runFiles(runId);
      expect(
        rows.map((row) => [row.size_bytes, row.deleted_at === null])
      ).toEqual([
        [1, false],
        [2, true],
      ]);
    });

    it("applies the same rule to a watcher older than 1.1.0", async () => {
      const runId = "dismissed-path-old-watcher";
      const oldWatcher = { [WATCHER_VERSION_HEADER]: "1.0.0" };
      await createRunWith(runId, reported(1), oldWatcher);
      await dismissAll(runId);

      await report(runId, reported(1), oldWatcher);
      expect(await runFiles(runId)).toHaveLength(1);

      await report(runId, reported(2, laterCreatedAt), oldWatcher);
      const rows = await runFiles(runId);
      expect(
        rows.map((row) => [row.size_bytes, row.deleted_at === null])
      ).toEqual([
        [1, false],
        [2, true],
      ]);
    });

    it("gives the new file a valid name when another folder holds the plain name", async () => {
      const runId = "dismissed-path-naming";
      const dismissedPath = "day-1/sample.tif";
      const otherPath = "day-2/sample.tif";
      await createRunWith(runId, reported(1, firstCreatedAt, dismissedPath));
      await dismissAll(runId);
      // The dismissed file doesn't hold the plain name, so this file gets it.
      await report(runId, reported(2, laterCreatedAt, otherPath));

      await report(runId, reported(3, laterCreatedAt, dismissedPath));

      const rows = await runFiles(runId);
      expect(
        rows.map((row) => [
          row.relative_path,
          row.filename,
          row.deleted_at === null,
        ])
      ).toEqual([
        [dismissedPath, "sample.tif", false],
        [otherPath, "sample.tif", true],
        [dismissedPath, taggedFilename("sample.tif", dismissedPath), true],
      ]);
    });

    it("gives a different file an upload URL and a row of its own", async () => {
      const runId = "dismissed-path-upload-different";
      await createRunWith(runId, reported(1));
      const [dismissed] = await runFiles(runId);
      await dismissAll(runId);

      const upload = await requestUpload(runId, reported(900, laterCreatedAt));
      expect(upload.status).toBe(200);
      const body = await upload.json();
      expect(body.already_uploaded).toBe(false);
      expect(body.upload_url).toBeTruthy();
      expect(body.s3_key).toBe(`${instrumentId}/${runId}/sample.tif`);
      expect(body.file_id).not.toBe(dismissed.id);

      const rows = await runFiles(runId);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === body.file_id)).toMatchObject({
        deleted_at: null,
        size_bytes: 900,
      });
      expect(
        rows.find((row) => row.id === dismissed.id)?.deleted_at
      ).toBeTruthy();

      // A second request for the same file reuses the new row.
      const again = await requestUpload(runId, reported(900, laterCreatedAt));
      expect((await again.json()).file_id).toBe(body.file_id);
      expect(await runFiles(runId)).toHaveLength(2);
    });

    it("returns 409 for the same file and stores nothing", async () => {
      const runId = "dismissed-path-upload-same";
      await createRunWith(runId, reported(1));
      await dismissAll(runId);

      const upload = await requestUpload(runId, reported(1));
      expect(upload.status).toBe(409);
      const rows = await runFiles(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deleted_at).toBeTruthy();
    });

    it("lets the Lambda add a file whose name matches a dismissed row's path", async () => {
      const runId = "dismissed-path-lambda";
      await createRunWith(runId, reported(1, firstCreatedAt, "result.csv"));
      const [dismissed] = await runFiles(runId);
      await dismissAll(runId);

      const lambdaBody = {
        s3_bucket: "test-bucket",
        s3_key: `${instrumentId}/${runId}/result.csv`,
        filename: "result.csv",
        size_bytes: 40,
      };
      const lambdaPost = () =>
        api(`/api/v1/instruments/${instrumentId}/runs/${runId}/files`, {
          method: "POST",
          token,
          body: lambdaBody,
        });
      const created = await lambdaPost();
      expect(created.status).toBe(201);
      const createdBody = await created.json();
      expect(createdBody.id).not.toBe(dismissed.id);
      expect(createdBody.status).toBe("uploaded");

      // A retry finds the row it made. There is still one active row.
      const retried = await lambdaPost();
      expect(retried.status).toBe(200);
      expect((await retried.json()).id).toBe(createdBody.id);
      const rows = await runFiles(runId);
      expect(rows.filter((row) => row.deleted_at === null)).toHaveLength(1);
      expect(rows).toHaveLength(2);
    });
  });

  async function filenames(runId: string): Promise<string[]> {
    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      { token }
    );
    const body = await detail.json();
    return body.files.map((file: { filename: string }) => file.filename);
  }
});
