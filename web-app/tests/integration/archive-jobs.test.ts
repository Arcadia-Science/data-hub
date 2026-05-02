import { archiveJobs, instrumentRuns, instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Tests for the /api/v1/archive-jobs/:id endpoints. These cover the surface
// the Lambda PATCHes when a build finishes and the UI polls while it waits.
// The actual zip building is exercised by Lambda unit tests; here we focus
// on auth, validation, and state transitions.
describe("Archive Jobs API", () => {
  let token: string;
  const instrumentId = "archive-jobs-test-instrument";
  const runId = "archive-jobs-test-run";
  let runInternalId: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Archive Jobs Test Instrument",
      status: "active",
    });
    const [run] = await db
      .insert(instrumentRuns)
      .values({
        instrumentId,
        runId,
        source: "watcher",
      })
      .returning({ id: instrumentRuns.id });
    runInternalId = run.id;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // --------------------------------------------------------------------
  // GET
  // --------------------------------------------------------------------

  it("GET requires authentication", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await api(`/api/v1/archive-jobs/${fakeId}`);
    expect(res.status).toBe(401);
  });

  it("GET returns 400 for non-uuid ids", async () => {
    const res = await api(`/api/v1/archive-jobs/not-a-uuid`, { token });
    expect(res.status).toBe(400);
  });

  it("GET returns 404 for unknown jobs", async () => {
    const fakeId = "11111111-1111-1111-1111-111111111111";
    const res = await api(`/api/v1/archive-jobs/${fakeId}`, { token });
    expect(res.status).toBe(404);
  });

  it("GET returns building status without a download_url", async () => {
    const db = getTestDb();
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint: "fp-building",
        status: "building",
      })
      .returning();

    const res = await api(`/api/v1/archive-jobs/${job.id}`, { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("building");
    expect(body.download_url).toBeNull();
  });

  it("GET returns a presigned download_url when ready", async () => {
    const db = getTestDb();
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint: "fp-ready",
        status: "ready",
        archiveBucket: "test-archives-bucket",
        archiveKey:
          "runs/archive-jobs-test-instrument/archive-jobs-test-run/fp-ready.zip",
        sizeBytes: 12345,
        completedAt: new Date(),
      })
      .returning();

    const res = await api(`/api/v1/archive-jobs/${job.id}`, { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.size_bytes).toBe(12345);
    expect(body.download_url).toContain("test-archives-bucket");
    // Presigned URL should embed the canonical archive key.
    expect(body.download_url).toContain("fp-ready.zip");
  });

  // --------------------------------------------------------------------
  // PATCH (Lambda callback)
  // --------------------------------------------------------------------

  it("PATCH requires authentication", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(
      `${process.env.__TEST_BASE_URL}/api/v1/archive-jobs/${fakeId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready" }),
      }
    );
    expect(res.status).toBe(401);
  });

  it("PATCH validates the status field", async () => {
    const db = getTestDb();
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint: "fp-validate",
        status: "building",
      })
      .returning();

    const res = await api(`/api/v1/archive-jobs/${job.id}`, {
      method: "PATCH",
      token,
      body: { status: "weird" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH requires bucket+key when status=ready", async () => {
    const db = getTestDb();
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint: "fp-need-bucket",
        status: "building",
      })
      .returning();

    const res = await api(`/api/v1/archive-jobs/${job.id}`, {
      method: "PATCH",
      token,
      body: { status: "ready" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH transitions a job to ready and stamps completed_at", async () => {
    const db = getTestDb();
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint: "fp-transition",
        status: "building",
      })
      .returning();

    const res = await api(`/api/v1/archive-jobs/${job.id}`, {
      method: "PATCH",
      token,
      body: {
        status: "ready",
        archive_bucket: "test-archives-bucket",
        archive_key:
          "runs/archive-jobs-test-instrument/archive-jobs-test-run/transition.zip",
        size_bytes: 9999,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.completed_at).not.toBeNull();

    // Verify the row was actually updated rather than just the response shaped.
    const [stored] = await db
      .select()
      .from(archiveJobs)
      .where(eq(archiveJobs.id, job.id));
    expect(stored.status).toBe("ready");
    expect(stored.archiveKey).toContain("transition.zip");
    expect(stored.completedAt).not.toBeNull();
  });

  it("PATCH records error_message and clears in-flight status on failure", async () => {
    const db = getTestDb();
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint: "fp-failure",
        status: "building",
      })
      .returning();

    const res = await api(`/api/v1/archive-jobs/${job.id}`, {
      method: "PATCH",
      token,
      body: { status: "failed", error_message: "S3 source missing" },
    });
    expect(res.status).toBe(200);

    const [stored] = await db
      .select()
      .from(archiveJobs)
      .where(eq(archiveJobs.id, job.id));
    expect(stored.status).toBe("failed");
    expect(stored.errorMessage).toBe("S3 source missing");
    expect(stored.completedAt).not.toBeNull();
  });

  // --------------------------------------------------------------------
  // Dedup
  // --------------------------------------------------------------------

  it("partial unique index prevents two in-flight jobs for the same fingerprint", async () => {
    const db = getTestDb();
    const fingerprint = "fp-dedup";
    await db.insert(archiveJobs).values({
      instrumentRunId: runInternalId,
      fingerprint,
      status: "building",
    });

    // A second insert with the same (run, fingerprint) and an in-flight
    // status MUST conflict — ON CONFLICT DO NOTHING returns no row, which
    // is what the route uses to attach to the existing job.
    const dupes = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint,
        status: "building",
      })
      .onConflictDoNothing()
      .returning();
    expect(dupes).toHaveLength(0);

    // A third insert at a TERMINAL status should be allowed because the
    // partial index excludes it. This matters when the same archive is
    // rebuilt after the previous build finished.
    const [terminal] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint,
        status: "ready",
        archiveBucket: "test-archives-bucket",
        archiveKey:
          "runs/archive-jobs-test-instrument/archive-jobs-test-run/dedup.zip",
        completedAt: new Date(),
      })
      .returning();
    expect(terminal).toBeDefined();

    // Cleanup so other tests aren't surprised by stray rows.
    await db
      .delete(archiveJobs)
      .where(
        and(
          eq(archiveJobs.instrumentRunId, runInternalId),
          eq(archiveJobs.fingerprint, fingerprint)
        )
      );
  });
});
