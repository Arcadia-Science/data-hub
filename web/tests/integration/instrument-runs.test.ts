import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  runCreated,
  runDeleted,
  runDetail,
  runListResponse,
  runUpdated,
} from "@/lib/api/openapi";
import { instruments } from "@/lib/db/schema";
import {
  api,
  clearCapturedSlackMessages,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
  waitForCapturedSlackMessages,
} from "@/tests/integration/helpers";

describe("Instrument Runs API", () => {
  let token: string;
  let userId: string;
  const instrumentId = "runs-test-instrument";

  beforeAll(async () => {
    await resetDb();
    ({ token, userId } = await seedTestUser());

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
    // Drift guard: the live response must match its documented OpenAPI schema
    // (responses aren't validated at runtime, so this is the only backstop).
    runCreated.parse(data);
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
    runCreated.parse(data);
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

  // Path traversal guard: the watcher joins `relative_path` onto
  // its watch directory and reads the result, so a `..`/absolute path would
  // let an attacker exfiltrate arbitrary files from the instrument PC. The
  // API must reject such payloads before they ever reach the files table.
  it.each([
    "../../etc/passwd",
    "../escape.csv",
    "sub/../../escape.csv",
    "/etc/passwd",
    "C:\\Windows\\system32\\config\\SAM",
    "..\\..\\secret.csv",
  ])("POST rejects detected_files with unsafe relative_path %s", async (bad) => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: `traversal-${encodeURIComponent(bad)}`,
        source: "watcher",
        detected_files: [{ relative_path: bad, filename: "passwd" }],
      },
    });
    expect(res.status).toBe(400);
  });

  it("POST rejects detected_files with unsafe filename", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: "traversal-filename",
        source: "watcher",
        detected_files: [
          { relative_path: "safe.csv", filename: "../../etc/passwd" },
        ],
      },
    });
    expect(res.status).toBe(400);
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
    runListResponse.parse(body);
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
    runListResponse.parse(body);
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
    runDetail.parse(data);
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
    runUpdated.parse(data);
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
    // The acting user (the PAT's owner) is recorded as the deleter.
    expect(data.deleted_by).toBe(userId);
    expect(data.already_applied).toBe(false);
    runDeleted.parse(data);
  });

  it("DELETE is idempotent — re-deleting an already-deleted run succeeds", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/run-001`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.already_applied).toBe(true);
    expect(data.deleted_at).toBeTruthy();
    expect(data.run_id).toBe("run-001");
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

// ---------------------------------------------------------------------------
// Slack notification on run creation
//
// The web app fires one Slack message per newly-created run. The
// `onConflictDoNothing` upsert in the route guarantees "first time only", so
// duplicate POSTs (which return 200) must not re-notify. We use a separate
// describe block so the capture buffer is isolated from the rest of the suite.
// ---------------------------------------------------------------------------

describe("Run creation Slack notification", () => {
  let token: string;
  const instrumentId = "slack-notif-instrument";
  const instrumentDisplayName = "Slack Notification Instrument";

  beforeAll(async () => {
    ({ token } = await seedTestUser());
    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: instrumentDisplayName,
      status: "active",
    });
  });

  beforeEach(async () => {
    await clearCapturedSlackMessages();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("POST sends a Slack message on first-time run creation only", async () => {
    const runId = "slack-run-001";

    const first = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: runId, source: "lambda" },
    });
    expect(first.status).toBe(201);

    const duplicate = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: runId, source: "lambda" },
    });
    expect(duplicate.status).toBe(200);

    const messages = await waitForCapturedSlackMessages(1);
    expect(messages[0].text).toContain(instrumentDisplayName);
    expect(messages[0].text).toContain(runId);
    expect(messages[0].text).toContain(
      `/instruments/${instrumentId}/runs/${runId}`
    );
    expect(messages[0].text).toContain("View in Data Hub");
  });
});

// ---------------------------------------------------------------------------
// Run acquisition time
//
// `acquired_at` is the run's actual on-instrument timestamp (min of the
// constituent files' birthtimes). It is supplied by the watcher on POST
// and may move earlier — never later — via subsequent PATCHes when an
// out-of-order stable file reveals an earlier birthtime. The list query
// also sorts and date-filters on coalesce(acquired_at, created_at).
// ---------------------------------------------------------------------------

describe("Run acquired_at", () => {
  let token: string;
  const instrumentId = "acquired-at-instrument";

  beforeAll(async () => {
    ({ token } = await seedTestUser());
    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Acquired-At Instrument",
      status: "active",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("POST stores explicit acquired_at and returns it on GET detail", async () => {
    const acquiredAt = "2025-01-15T08:30:00.000Z";
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: "explicit-acquired",
        source: "watcher",
        acquired_at: acquiredAt,
      },
    });
    expect(res.status).toBe(201);

    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/explicit-acquired`,
      { token }
    );
    const data = await detail.json();
    expect(new Date(data.acquired_at).toISOString()).toBe(acquiredAt);
  });

  it("POST without acquired_at derives the floor from detected_files", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: "derived-acquired",
        source: "watcher",
        detected_files: [
          {
            relative_path: "later.csv",
            filename: "later.csv",
            size_bytes: 10,
            file_created_at: "2025-02-01T12:00:00.000Z",
          },
          {
            relative_path: "earliest.csv",
            filename: "earliest.csv",
            size_bytes: 20,
            file_created_at: "2025-02-01T10:00:00.000Z",
          },
        ],
      },
    });
    expect(res.status).toBe(201);

    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/derived-acquired`,
      { token }
    );
    const data = await detail.json();
    expect(new Date(data.acquired_at).toISOString()).toBe(
      "2025-02-01T10:00:00.000Z"
    );
  });

  it("PATCH with an earlier acquired_at moves the value backward", async () => {
    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: "patch-earlier",
        source: "watcher",
        acquired_at: "2025-03-10T12:00:00.000Z",
      },
    });

    const patch = await api(
      `/api/v1/instruments/${instrumentId}/runs/patch-earlier`,
      {
        method: "PATCH",
        token,
        body: { acquired_at: "2025-03-10T08:00:00.000Z" },
      }
    );
    expect(patch.status).toBe(200);
    const data = await patch.json();
    expect(new Date(data.acquired_at).toISOString()).toBe(
      "2025-03-10T08:00:00.000Z"
    );
  });

  it("PATCH with a later acquired_at is ignored (LEAST semantics)", async () => {
    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: "patch-later",
        source: "watcher",
        acquired_at: "2025-04-05T08:00:00.000Z",
      },
    });

    const patch = await api(
      `/api/v1/instruments/${instrumentId}/runs/patch-later`,
      {
        method: "PATCH",
        token,
        body: { acquired_at: "2025-04-05T20:00:00.000Z" },
      }
    );
    expect(patch.status).toBe(200);
    const data = await patch.json();
    expect(new Date(data.acquired_at).toISOString()).toBe(
      "2025-04-05T08:00:00.000Z"
    );
  });

  it("GET list orders by coalesce(acquired_at, created_at) by default", async () => {
    // Insert two backfilled runs whose acquired_at predates the runs
    // already created in this describe block. The default sort (desc)
    // should still place them after the current-day runs because their
    // acquired_at is older — even though they were inserted later (so
    // their created_at is newer).
    const newest = "2030-01-01T00:00:00.000Z";
    const oldest = "2010-01-01T00:00:00.000Z";

    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: "sort-newest",
        source: "watcher",
        acquired_at: newest,
      },
    });
    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: "sort-oldest",
        source: "watcher",
        acquired_at: oldest,
      },
    });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs?per_page=100`,
      { token }
    );
    const body = await res.json();
    const ids: string[] = body.data.map((r: { run_id: string }) => r.run_id);
    expect(ids.indexOf("sort-newest")).toBeLessThan(ids.indexOf("sort-oldest"));
    // sort-newest should be first overall — its acquired_at (year 2030)
    // is later than every other run's acquired_at OR created_at.
    expect(ids[0]).toBe("sort-newest");
  });

  // Regression: drizzle's `gte`/`lte` against a raw SQL fragment skips the
  // column-level type coercion, so a JS Date would reach the driver untyped.
  // The implementation binds ISO strings explicitly and casts to timestamptz
  // on the server.
  it("GET list date_from/date_to filter against coalesce(acquired_at, created_at)", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs?date_from=2009-01-01&date_to=2010-12-31&per_page=100`,
      { token }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((r: { run_id: string }) => r.run_id);
    expect(ids).toContain("sort-oldest");
    expect(ids).not.toContain("sort-newest");
  });
});
