import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Instrument Runs API", () => {
  let token: string;
  const instrumentId = "runs-test-instrument";

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Runs Test Instrument",
      status: "active",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/instruments/:instrumentId/runs
  // -------------------------------------------------------------------------

  it("POST creates a new run", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: "run-001", source: "lambda" },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.instrument_id).toBe(instrumentId);
    expect(data.run_id).toBe("run-001");
    expect(data.source).toBe("lambda");
    expect(data.id).toBeTruthy();
  });

  // Run creation is idempotent on (instrument_id, run_id). This handles the
  // race where a Lambda auto-creates a run that was already reported by the
  // watcher — the second call returns the existing record with 200 instead of 201.
  it("POST is idempotent — returns 200 for duplicate run_id", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: "run-001", source: "lambda" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.run_id).toBe("run-001");
  });

  it("POST rejects missing run_id", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { source: "lambda" },
    });
    expect(res.status).toBe(400);
  });

  it("POST rejects invalid source", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: "run-bad-source", source: "invalid" },
    });
    expect(res.status).toBe(400);
  });

  it("POST returns 404 for nonexistent instrument", async () => {
    const res = await api("/api/v1/instruments/nonexistent/runs", {
      method: "POST",
      token,
      body: { run_id: "run-x", source: "lambda" },
    });
    expect(res.status).toBe(404);
  });

  // Watcher payloads can include detected_files alongside the run creation,
  // allowing atomic reporting of a run and its constituent files in a single
  // request. Files start in "detected" status (not yet uploaded to S3).
  it("POST with detected_files creates file records alongside the run", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: "run-with-files",
        source: "watcher",
        detected_files: [
          {
            relative_path: "data_1.csv",
            filename: "data_1.csv",
            size_bytes: 1024,
          },
          {
            relative_path: "data_2.csv",
            filename: "data_2.csv",
            size_bytes: 2048,
          },
        ],
      },
    });
    expect(res.status).toBe(201);

    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/run-with-files`,
      { token }
    );
    const detailData = await detail.json();
    expect(detailData.files.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/instruments/:instrumentId/runs
  // -------------------------------------------------------------------------

  it("GET lists runs for an instrument with pagination", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      token,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.pagination).toBeTruthy();
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it("GET supports source filter", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs?source=lambda`,
      { token }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const run of body.data) {
      expect(run.source).toBe("lambda");
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/instrument-runs (cross-instrument)
  // -------------------------------------------------------------------------

  it("GET /api/v1/instrument-runs lists runs across instruments", async () => {
    const res = await api("/api/v1/instrument-runs", { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.pagination).toBeTruthy();
  });

  it("GET /api/v1/instrument-runs supports instrument_id filter", async () => {
    const res = await api(
      `/api/v1/instrument-runs?instrument_id=${instrumentId}`,
      { token }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const run of body.data) {
      expect(run.instrument_id).toBe(instrumentId);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/instruments/:instrumentId/runs/:runId
  // -------------------------------------------------------------------------

  it("GET returns full run detail with files", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/run-001`, {
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.run_id).toBe("run-001");
    expect(data.instrument_id).toBe(instrumentId);
    expect(data).toHaveProperty("files");
    expect(data).toHaveProperty("metadata");
  });

  it("GET returns 404 for nonexistent run", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/nonexistent-run`,
      { token }
    );
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/instruments/:instrumentId/runs/:runId
  // -------------------------------------------------------------------------

  // Metadata is a full replacement (not a deep merge). The Lambda writes the
  // complete metadata object after processing all files.
  it("PATCH updates run metadata", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/run-001`, {
      method: "PATCH",
      token,
      body: { metadata: { assay: "Bradford", plate: "96-well" } },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.metadata).toEqual({ assay: "Bradford", plate: "96-well" });
  });

  it("PATCH rejects non-object metadata", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/run-001`, {
      method: "PATCH",
      token,
      body: { metadata: "not-an-object" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH returns 404 for nonexistent run", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/nonexistent`,
      { method: "PATCH", token, body: { metadata: {} } }
    );
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/instruments/:instrumentId/runs/:runId
  // -------------------------------------------------------------------------

  // Runs are soft-deleted (deleted_at set). Data Hub never hard-deletes runs
  // or S3 objects, so a soft-deleted run can always be restored.
  it("DELETE soft-deletes a run", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/run-001`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted_at).toBeTruthy();
    expect(data.run_id).toBe("run-001");
  });

  it("DELETE returns 409 for already-deleted run", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/run-001`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(409);
  });

  it("GET excludes soft-deleted runs by default", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      token,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.data.find(
      (r: { run_id: string }) => r.run_id === "run-001"
    );
    expect(found).toBeFalsy();
  });

  it("GET with include_deleted=true includes soft-deleted runs", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs?include_deleted=true`,
      { token }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.data.find(
      (r: { run_id: string }) => r.run_id === "run-001"
    );
    expect(found).toBeTruthy();
    expect(found.deleted_at).toBeTruthy();
  });

  it("PATCH returns 409 for soft-deleted run", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/run-001`, {
      method: "PATCH",
      token,
      body: { metadata: { should: "fail" } },
    });
    expect(res.status).toBe(409);
  });
});
