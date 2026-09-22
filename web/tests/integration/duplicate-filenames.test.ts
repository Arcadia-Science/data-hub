import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taggedFilename } from "@/lib/api/run-file-identity";
import { WATCHER_VERSION_HEADER } from "@/lib/api/watcher-compat";
import { files, instruments } from "@/lib/db/schema";
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

  it("returns 409 when a dismissed file already uses the path", async () => {
    const runId = "dismissed-path";
    const relativePath = "capture/sample.tif";
    const created = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      headers: watcherHeaders,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          {
            relative_path: relativePath,
            filename: "sample.tif",
            size_bytes: 1,
          },
        ],
      },
    });
    expect(created.status).toBe(201);

    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      { token }
    );
    const before = await detail.json();
    await getTestDb()
      .update(files)
      .set({ deletedAt: new Date() })
      .where(eq(files.id, before.files[0].id));

    const upload = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        headers: watcherHeaders,
        body: {
          filename: "sample.tif",
          relative_path: relativePath,
          size_bytes: 1,
        },
      }
    );
    expect(upload.status).toBe(409);
    expect(await filenames(runId)).toEqual(["sample.tif"]);
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
