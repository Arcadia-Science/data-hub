import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files, instrumentRuns, instruments, watchers } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Regression coverage for the "stuck on Uploading" bug: queueing an upload
// while the instrument has no online watcher used to succeed, leaving files in
// `upload_requested` forever with no watcher to push them to S3. Both
// upload-request endpoints now reject with 409 WATCHER_OFFLINE up front.

async function seedRun(
  instrumentId: string,
  runId: string,
  token: string
): Promise<number[]> {
  const db = getTestDb();
  await db.insert(instruments).values({
    id: instrumentId,
    displayName: `Instrument ${instrumentId}`,
    status: "active",
  });

  await api(`/api/v1/instruments/${instrumentId}/runs`, {
    method: "POST",
    token,
    body: {
      run_id: runId,
      source: "watcher",
      detected_files: [
        { relative_path: "a.csv", filename: "a.csv", size_bytes: 128 },
        { relative_path: "b.csv", filename: "b.csv", size_bytes: 256 },
      ],
    },
  });

  const [run] = await db
    .select({ id: instrumentRuns.id })
    .from(instrumentRuns)
    .where(
      and(
        eq(instrumentRuns.instrumentId, instrumentId),
        eq(instrumentRuns.runId, runId)
      )
    );
  const fileRows = await db
    .select({ id: files.id })
    .from(files)
    .where(eq(files.instrumentRunId, run.id));
  return fileRows.map((f) => f.id);
}

describe("Request Upload — watcher offline guard", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // No watcher at all
  // -------------------------------------------------------------------------

  it("rejects request-upload when the instrument has no watcher", async () => {
    const instrumentId = "no-watcher-inst";
    const runId = "run-1";
    const fileIds = await seedRun(instrumentId, runId, token);

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload`,
      { method: "POST", token, body: { file_ids: fileIds } }
    );

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("WATCHER_OFFLINE");

    // The files must remain "detected" — nothing should have been queued.
    const db = getTestDb();
    const rows = await db
      .select({ status: files.status })
      .from(files)
      .where(eq(files.id, fileIds[0]));
    expect(rows[0].status).toBe("detected");
  });

  it("rejects request-upload-all when the instrument has no watcher", async () => {
    const instrumentId = "no-watcher-inst-all";
    const runId = "run-1";
    await seedRun(instrumentId, runId, token);

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-all`,
      { method: "POST", token }
    );

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("WATCHER_OFFLINE");
  });

  // -------------------------------------------------------------------------
  // Stale watcher (heartbeat older than the staleness window)
  // -------------------------------------------------------------------------

  it("rejects when the only watcher's heartbeat is stale", async () => {
    const instrumentId = "stale-watcher-inst";
    const runId = "run-1";
    await seedRun(instrumentId, runId, token);

    const db = getTestDb();
    await db.insert(watchers).values({
      instrumentId,
      hostname: "stale-pc",
      status: "watching",
      // 10 minutes ago — well past the 5-minute staleness window.
      lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-all`,
      { method: "POST", token }
    );

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("WATCHER_OFFLINE");
  });

  it("rejects when the only watcher is registered but not watching", async () => {
    const instrumentId = "registered-watcher-inst";
    const runId = "run-1";
    await seedRun(instrumentId, runId, token);

    const db = getTestDb();
    await db.insert(watchers).values({
      instrumentId,
      hostname: "registered-pc",
      status: "registered",
      lastHeartbeatAt: new Date(),
    });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-all`,
      { method: "POST", token }
    );

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("WATCHER_OFFLINE");
  });

  // -------------------------------------------------------------------------
  // Online watcher — uploads are allowed
  // -------------------------------------------------------------------------

  it("allows request-upload when an online watcher exists", async () => {
    const instrumentId = "online-watcher-inst";
    const runId = "run-1";
    const fileIds = await seedRun(instrumentId, runId, token);

    const db = getTestDb();
    await db.insert(watchers).values({
      instrumentId,
      hostname: "online-pc",
      status: "watching",
      lastHeartbeatAt: new Date(),
    });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload`,
      { method: "POST", token, body: { file_ids: fileIds } }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files_queued).toBe(fileIds.length);

    const rows = await db
      .select({ status: files.status })
      .from(files)
      .where(eq(files.id, fileIds[0]));
    expect(rows[0].status).toBe("upload_requested");
  });

  it("allows request-upload-all when an online watcher exists", async () => {
    const instrumentId = "online-watcher-inst-all";
    const runId = "run-1";
    await seedRun(instrumentId, runId, token);

    const db = getTestDb();
    await db.insert(watchers).values({
      instrumentId,
      hostname: "online-pc-all",
      status: "watching",
      lastHeartbeatAt: new Date(),
    });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-all`,
      { method: "POST", token }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files_queued).toBe(2);
  });
});
