import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Files have two distinct lifecycle paths through the status state machine:
//
//   Watcher path:  detected → [upload_requested →] uploaded → processing → completed|failed
//   Lambda path:   (created as "uploaded" via POST .../files) → processing → completed|failed
//
// The watcher path starts with files detected on a local filesystem that must
// be uploaded to S3. The Lambda path starts with files already in S3 (the
// Lambda function creates the file record after the S3 object exists).
//
// `fileId` tracks a watcher-path file; `lambdaFileId` tracks a Lambda-path file.
// Tests drive each through its full lifecycle to verify the state machine.
describe("Files API", () => {
  let token: string;
  const instrumentId = "files-test-instrument";
  const runId = "files-test-run";
  let fileId: number;
  let secondFileId: number;
  let thirdFileId: number;
  let lambdaFileId: number;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Files Test Instrument",
      status: "active",
    });

    // Create a run with detected files (watcher path)
    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          {
            relative_path: "sample.csv",
            filename: "sample.csv",
            size_bytes: 512,
          },
          {
            relative_path: "sample2.csv",
            filename: "sample2.csv",
            size_bytes: 1024,
          },
          {
            relative_path: "sample3.csv",
            filename: "sample3.csv",
            size_bytes: 256,
          },
        ],
      },
    });

    // Fetch the run and store file IDs by filename for targeted assertions.
    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      { token }
    );
    const detailData = await detail.json();
    const byName = (name: string) =>
      detailData.files.find((f: { filename: string }) => f.filename === name)!
        .id;
    fileId = byName("sample.csv");
    secondFileId = byName("sample2.csv");
    thirdFileId = byName("sample3.csv");
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/instruments/:instrumentId/runs/:runId/files (Lambda path)
  // -------------------------------------------------------------------------

  // Lambda creates files already in S3, so they start in "uploaded" status
  // rather than "detected". The s3_bucket/s3_key identify the S3 object.
  it("POST creates a file with uploaded status (Lambda path)", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/files`,
      {
        method: "POST",
        token,
        body: {
          s3_bucket: "test-bucket",
          s3_key: `${instrumentId}/${runId}/processed_output.csv`,
          filename: "processed_output.csv",
          content_type: "text/csv",
          size_bytes: 4096,
          category: "processed",
        },
      }
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.status).toBe("uploaded");
    expect(data.s3_bucket).toBe("test-bucket");
    expect(data.category).toBe("processed");
    lambdaFileId = data.id;
  });

  // Idempotent on s3_key via a partial unique index. This prevents duplicate
  // file records when the Lambda retries after a timeout.
  it("POST is idempotent on s3_key — returns 200 for duplicate", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/files`,
      {
        method: "POST",
        token,
        body: {
          s3_bucket: "test-bucket",
          s3_key: `${instrumentId}/${runId}/processed_output.csv`,
          filename: "processed_output.csv",
        },
      }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(lambdaFileId);
  });

  it("POST rejects missing required fields", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/files`,
      {
        method: "POST",
        token,
        body: { filename: "test.csv" },
      }
    );
    expect(res.status).toBe(400);
  });

  it("POST returns 404 for nonexistent run", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/nonexistent-run/files`,
      {
        method: "POST",
        token,
        body: {
          s3_bucket: "b",
          s3_key: "k",
          filename: "f.csv",
        },
      }
    );
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/files/:fileId — watcher path (detected → uploaded)
  // -------------------------------------------------------------------------

  // Watcher path: after the watcher uploads the file to S3, it calls PATCH
  // to transition detected → uploaded and attach the S3 coordinates.
  it("PATCH transitions detected → uploaded with S3 info", async () => {
    const res = await api(`/api/v1/files/${fileId}`, {
      method: "PATCH",
      token,
      body: {
        status: "uploaded",
        s3_bucket: "test-bucket",
        s3_key: `${instrumentId}/${runId}/sample.csv`,
        content_type: "text/csv",
        size_bytes: 512,
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("uploaded");
    expect(data.s3_bucket).toBe("test-bucket");
    expect(data.uploaded_at).toBeTruthy();
  });

  it("PATCH transitions uploaded → processing", async () => {
    const res = await api(`/api/v1/files/${fileId}`, {
      method: "PATCH",
      token,
      body: { status: "processing" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("processing");
  });

  it("PATCH transitions processing → completed with metadata", async () => {
    const res = await api(`/api/v1/files/${fileId}`, {
      method: "PATCH",
      token,
      body: {
        status: "completed",
        metadata: { plate_type: "96-well", read_mode: "absorbance" },
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("completed");
    expect(data.processed_at).toBeTruthy();
    expect(data.metadata).toEqual({
      plate_type: "96-well",
      read_mode: "absorbance",
    });
  });

  // "completed" and "failed" are terminal states — the state machine
  // forbids any further transitions to prevent data corruption.
  it("PATCH rejects invalid status transition (completed → uploaded)", async () => {
    const res = await api(`/api/v1/files/${fileId}`, {
      method: "PATCH",
      token,
      body: { status: "uploaded" },
    });
    expect(res.status).toBe(409);
  });

  it("PATCH transitions processing → failed with error_message", async () => {
    // Use the Lambda-created file for this test path
    // First transition to processing
    await api(`/api/v1/files/${lambdaFileId}`, {
      method: "PATCH",
      token,
      body: { status: "processing" },
    });

    const res = await api(`/api/v1/files/${lambdaFileId}`, {
      method: "PATCH",
      token,
      body: {
        status: "failed",
        error_message: "Parser could not recognize file format",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("failed");
    expect(data.error_message).toBe("Parser could not recognize file format");
  });

  it("PATCH returns 404 for nonexistent file", async () => {
    const res = await api("/api/v1/files/999999", {
      method: "PATCH",
      token,
      body: { status: "uploaded" },
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/files/:fileId
  // -------------------------------------------------------------------------

  it("DELETE soft-deletes a detected file", async () => {
    const res = await api(`/api/v1/files/${secondFileId}`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted_at).toBeTruthy();
  });

  // Once a file has been uploaded to S3, it can only be removed via the
  // run-level DELETE (which handles S3 lifecycle). Per-file DELETE is
  // limited to pre-upload states to prevent orphaned S3 objects.
  it("DELETE rejects dismissal of uploaded files", async () => {
    const res = await api(`/api/v1/files/${fileId}`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(409);
  });

  it("DELETE returns 404 for nonexistent file", async () => {
    const res = await api("/api/v1/files/999999", {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/files/:fileId/reprocess
  //
  // At this point in the test lifecycle:
  //   fileId (sample.csv)             → completed, has S3 info
  //   secondFileId (sample2.csv)      → detected, soft-deleted
  //   thirdFileId (sample3.csv)       → detected, not deleted
  //   lambdaFileId (processed_output) → failed, has S3 info
  // -------------------------------------------------------------------------

  it("REPROCESS returns 401 without auth", async () => {
    const res = await api(`/api/v1/files/${lambdaFileId}/reprocess`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("REPROCESS returns 400 for invalid file ID", async () => {
    const res = await api("/api/v1/files/abc/reprocess", {
      method: "POST",
      token,
    });
    expect(res.status).toBe(400);
  });

  it("REPROCESS returns 404 for nonexistent file", async () => {
    const res = await api("/api/v1/files/999999/reprocess", {
      method: "POST",
      token,
    });
    expect(res.status).toBe(404);
  });

  it("REPROCESS returns 409 for non-reprocessable status (detected)", async () => {
    const res = await api(`/api/v1/files/${thirdFileId}/reprocess`, {
      method: "POST",
      token,
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.message).toContain("detected");
  });

  it("REPROCESS returns 409 for soft-deleted file", async () => {
    const res = await api(`/api/v1/files/${secondFileId}/reprocess`, {
      method: "POST",
      token,
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.message).toContain("soft-deleted");
  });

  // Create a dedicated run, add a failed file, then soft-delete the run
  // to verify the parent-run guard without affecting other tests.
  it("REPROCESS returns 409 when parent run is soft-deleted", async () => {
    // Create a run and a file via the Lambda path.
    const deletedRunId = "reprocess-deleted-run";
    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: deletedRunId, source: "lambda" },
    });
    const createFileRes = await api(
      `/api/v1/instruments/${instrumentId}/runs/${deletedRunId}/files`,
      {
        method: "POST",
        token,
        body: {
          s3_bucket: "test-bucket",
          s3_key: `${instrumentId}/${deletedRunId}/data.csv`,
          filename: "data.csv",
        },
      }
    );
    const createdFile = await createFileRes.json();

    // Transition the file to "failed" so it would normally be reprocessable.
    await api(`/api/v1/files/${createdFile.id}`, {
      method: "PATCH",
      token,
      body: { status: "processing" },
    });
    await api(`/api/v1/files/${createdFile.id}`, {
      method: "PATCH",
      token,
      body: { status: "failed", error_message: "intentional failure" },
    });

    // Soft-delete the parent run.
    await api(`/api/v1/instruments/${instrumentId}/runs/${deletedRunId}`, {
      method: "DELETE",
      token,
    });

    const res = await api(`/api/v1/files/${createdFile.id}/reprocess`, {
      method: "POST",
      token,
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.message).toContain("parent run");
  });

  // These two tests verify that both reprocessable statuses (failed and
  // completed) pass all validation guards. They return 503 because the
  // test server has no LAMBDA_FUNCTION_URL / LAMBDA_INVOKE_TOKEN configured.
  it("REPROCESS returns 503 for failed file when Lambda is not configured", async () => {
    const res = await api(`/api/v1/files/${lambdaFileId}/reprocess`, {
      method: "POST",
      token,
    });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error.message).toContain("not configured");
  });

  it("REPROCESS returns 503 for completed file when Lambda is not configured", async () => {
    const res = await api(`/api/v1/files/${fileId}/reprocess`, {
      method: "POST",
      token,
    });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error.message).toContain("not configured");
  });
});
