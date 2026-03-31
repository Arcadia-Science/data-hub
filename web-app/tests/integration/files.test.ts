import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instruments } from "../../lib/db/schema";
import { api, closeTestDb, getTestDb, resetDb, seedTestUser } from "./helpers";

describe("Files API", () => {
  let token: string;
  const instrumentId = "files-test-instrument";
  const runId = "files-test-run";
  let fileId: number;
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
        ],
      },
    });

    // Fetch the run to get file IDs
    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      { token }
    );
    const detailData = await detail.json();
    fileId = detailData.files[0].id;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/instruments/:instrumentId/runs/:runId/files (Lambda path)
  // -------------------------------------------------------------------------

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

  it("PATCH transitions processing → completed with metadata and report_data", async () => {
    const res = await api(`/api/v1/files/${fileId}`, {
      method: "PATCH",
      token,
      body: {
        status: "completed",
        metadata: { plate_type: "96-well", read_mode: "absorbance" },
        report_data: [
          {
            data_type: "raw_well_data",
            data: [
              { well: "A1", value: 0.123 },
              { well: "A2", value: 0.456 },
            ],
          },
        ],
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
    // Use the second detected file (sample2.csv) which is still in detected status
    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      { token }
    );
    const detailData = await detail.json();
    const detectedFile = detailData.files.find(
      (f: { status: string; relative_path: string }) =>
        f.status === "detected" && f.relative_path === "sample2.csv"
    );
    expect(detectedFile).toBeTruthy();

    const res = await api(`/api/v1/files/${detectedFile.id}`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted_at).toBeTruthy();
  });

  it("DELETE rejects dismissal of uploaded files", async () => {
    // fileId is now in "completed" status
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
});
