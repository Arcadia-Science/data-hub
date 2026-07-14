import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uploadUrlResponse } from "@/lib/api/openapi";
import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

describe("Request Upload URL API", () => {
  let token: string;
  const instrumentId = "upload-url-test-instrument";
  const runId = "upload-url-test-run";

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Upload URL Test Instrument",
      status: "active",
    });

    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          {
            relative_path: "existing.csv",
            filename: "existing.csv",
            size_bytes: 512,
          },
        ],
      },
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("returns presigned URL for a new file in a valid run", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "new_data.csv", content_type: "text/csv" },
      }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upload_url).toBeTruthy();
    expect(data.s3_bucket).toBeTruthy();
    expect(data.s3_key).toBe(`${instrumentId}/${runId}/new_data.csv`);
    expect(data.file_id).toBeGreaterThan(0);
    expect(data.expires_in).toBe(3600);
    expect(data.already_uploaded).toBe(false);
    // Drift guard: the live response must match its documented OpenAPI schema
    // (responses aren't validated at runtime, so this is the only backstop).
    uploadUrlResponse.parse(data);
  });

  it("creates a file record if none exists", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "brand_new.csv" },
      }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.file_id).toBeGreaterThan(0);
    expect(data.already_uploaded).toBe(false);
  });

  it("reuses existing detected file record", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "existing.csv" },
      }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.already_uploaded).toBe(false);
    expect(data.upload_url).toBeTruthy();
  });

  it("returns already_uploaded for files past uploaded status", async () => {
    // First, get a presigned URL and the file_id for a new file
    const urlRes = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "already_done.csv" },
      }
    );
    const urlData = await urlRes.json();
    const fileId = urlData.file_id;

    // Mark it as uploaded via PATCH
    await api(`/api/v1/files/${fileId}`, {
      method: "PATCH",
      token,
      body: {
        status: "uploaded",
        s3_bucket: "test-bucket",
        s3_key: `${instrumentId}/${runId}/already_done.csv`,
      },
    });

    // Request again — should short-circuit
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "already_done.csv" },
      }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.already_uploaded).toBe(true);
    expect(data.file_id).toBe(fileId);
    uploadUrlResponse.parse(data);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it("rejects missing filename", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: {},
      }
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent instrument/run", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/nonexistent-run/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "data.csv" },
      }
    );
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it("requires authentication", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        body: { filename: "data.csv" },
      }
    );
    expect(res.status).toBe(401);
  });
});
