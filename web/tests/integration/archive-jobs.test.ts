import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  expireStaleArchiveJobs,
  STUCK_BUILD_ERROR_MESSAGE,
  STUCK_BUILD_TIMEOUT_MS,
} from "@/lib/api/archive-jobs";
import { archiveJobs, instrumentRuns, instruments } from "@/lib/db/schema";
import {
  closeTestDb,
  getBaseUrl,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Tests for the /api/v1/archive-jobs/:id PATCH callback the Lambda fires
// when a build finishes. The UI doesn't poll this endpoint — it re-issues
// /download-archive instead — so there is no GET handler on this route;
// only the Lambda → web app callback. The actual zip building is exercised
// by Lambda unit tests; here we focus on auth, validation, state
// transitions, the partial-unique-index dedup, and the stuck-row sweep.
describe("Archive Jobs API", () => {
  let token: string;
  const instrumentId = "archive-jobs-test-instrument";
  const runId = "archive-jobs-test-run";
  let runInternalId: string;

  // PATCH the archive-job endpoint with bearer auth. In production the
  // caller is the Lambda using its `DATA_HUB_API_KEY` PAT; here the seeded
  // test user's token stands in for it (the route doesn't differentiate
  // between PATs — see the comment on the route handler).
  async function patchJob(
    jobId: string,
    body: Record<string, unknown>,
    options: { token?: string } = {}
  ) {
    return fetch(`${getBaseUrl()}/api/v1/archive-jobs/${jobId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token ?? token}`,
      },
      body: JSON.stringify(body),
    });
  }

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
  // PATCH (Lambda callback)
  // --------------------------------------------------------------------

  it("PATCH requires authentication (no auth header)", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${getBaseUrl()}/api/v1/archive-jobs/${fakeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    });
    expect(res.status).toBe(401);
  });

  it("PATCH rejects an invalid bearer token", async () => {
    const db = getTestDb();
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint: "fp-wrong-token",
        status: "building",
      })
      .returning();

    const res = await patchJob(
      job.id,
      { status: "failed", error_message: "tampered" },
      { token: "dhub_not-a-real-token" }
    );
    expect(res.status).toBe(401);

    const [stored] = await db
      .select()
      .from(archiveJobs)
      .where(eq(archiveJobs.id, job.id));
    expect(stored.status).toBe("building");
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

    const res = await patchJob(job.id, { status: "weird" });
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

    const res = await patchJob(job.id, { status: "ready" });
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

    const res = await patchJob(job.id, {
      status: "ready",
      archive_bucket: "test-archives-bucket",
      archive_key:
        "runs/archive-jobs-test-instrument/archive-jobs-test-run/transition.zip",
      size_bytes: 9999,
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

    const res = await patchJob(job.id, {
      status: "failed",
      error_message: "S3 source missing",
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

  // --------------------------------------------------------------------
  // Stale-row expiry (`expireStaleArchiveJobs`)
  // --------------------------------------------------------------------

  it("expireStaleArchiveJobs flips an old `building` row to `failed`", async () => {
    const db = getTestDb();
    const fingerprint = "fp-stale";
    const ancient = new Date(Date.now() - STUCK_BUILD_TIMEOUT_MS - 60_000);
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint,
        status: "building",
        createdAt: ancient,
      })
      .returning();

    const expired = await expireStaleArchiveJobs(runInternalId, fingerprint, {
      db,
    });
    expect(expired).toBe(1);

    const [stored] = await db
      .select()
      .from(archiveJobs)
      .where(eq(archiveJobs.id, job.id));
    expect(stored.status).toBe("failed");
    expect(stored.errorMessage).toBe(STUCK_BUILD_ERROR_MESSAGE);
    expect(stored.completedAt).not.toBeNull();

    // Cleanup.
    await db.delete(archiveJobs).where(eq(archiveJobs.id, job.id));
  });

  it("expireStaleArchiveJobs leaves a fresh `building` row alone", async () => {
    const db = getTestDb();
    const fingerprint = "fp-fresh";
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint,
        status: "building",
        // createdAt defaults to now() — well inside the timeout window.
      })
      .returning();

    const expired = await expireStaleArchiveJobs(runInternalId, fingerprint, {
      db,
    });
    expect(expired).toBe(0);

    const [stored] = await db
      .select()
      .from(archiveJobs)
      .where(eq(archiveJobs.id, job.id));
    expect(stored.status).toBe("building");

    await db.delete(archiveJobs).where(eq(archiveJobs.id, job.id));
  });

  it("expireStaleArchiveJobs ignores rows for other (run, fingerprint) pairs", async () => {
    const db = getTestDb();
    const ancient = new Date(Date.now() - STUCK_BUILD_TIMEOUT_MS - 60_000);
    const [otherRun] = await db
      .insert(instrumentRuns)
      .values({
        instrumentId,
        runId: "other-run-for-expiry",
        source: "watcher",
      })
      .returning({ id: instrumentRuns.id });

    // A stale row under a different run + a stale row with the same run but
    // a different fingerprint. Neither should be touched by an expiry call
    // scoped to (runInternalId, "fp-target").
    const [otherRunRow] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: otherRun.id,
        fingerprint: "fp-target",
        status: "building",
        createdAt: ancient,
      })
      .returning();
    const [wrongFpRow] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint: "fp-not-target",
        status: "building",
        createdAt: ancient,
      })
      .returning();

    const expired = await expireStaleArchiveJobs(runInternalId, "fp-target", {
      db,
    });
    expect(expired).toBe(0);

    for (const id of [otherRunRow.id, wrongFpRow.id]) {
      const [row] = await db
        .select()
        .from(archiveJobs)
        .where(eq(archiveJobs.id, id));
      expect(row.status).toBe("building");
    }

    await db
      .delete(archiveJobs)
      .where(inArray(archiveJobs.id, [otherRunRow.id, wrongFpRow.id]));
    await db.delete(instrumentRuns).where(eq(instrumentRuns.id, otherRun.id));
  });

  it("expireStaleArchiveJobs is a no-op against a terminal `ready` row even if old", async () => {
    const db = getTestDb();
    const fingerprint = "fp-old-ready";
    const ancient = new Date(Date.now() - STUCK_BUILD_TIMEOUT_MS - 60_000);
    const [job] = await db
      .insert(archiveJobs)
      .values({
        instrumentRunId: runInternalId,
        fingerprint,
        status: "ready",
        archiveBucket: "test-archives-bucket",
        archiveKey: "runs/x/y/old.zip",
        completedAt: ancient,
        createdAt: ancient,
      })
      .returning();

    const expired = await expireStaleArchiveJobs(runInternalId, fingerprint, {
      db,
    });
    expect(expired).toBe(0);

    const [stored] = await db
      .select()
      .from(archiveJobs)
      .where(eq(archiveJobs.id, job.id));
    expect(stored.status).toBe("ready");

    await db.delete(archiveJobs).where(eq(archiveJobs.id, job.id));
  });
});
