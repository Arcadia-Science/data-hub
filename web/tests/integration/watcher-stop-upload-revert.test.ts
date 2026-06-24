import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  files,
  instrumentRuns,
  instruments,
  watcherEvents,
  watchers,
} from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// A non-`watching` heartbeat (graceful `stopped` on shutdown) reverts the
// instrument's still-queued upload requests to `detected` so they don't sit
// stuck with no watcher to drain them.

async function seedQueuedRun(
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
        { relative_path: "a.csv", filename: "a.csv", size_bytes: 1 },
        { relative_path: "b.csv", filename: "b.csv", size_bytes: 1 },
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
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(eq(files.instrumentRunId, run.id));
  const ids = rows.map((r) => r.id);

  await db
    .update(files)
    .set({ status: "upload_requested", uploadRequestedAt: new Date() })
    .where(inArray(files.id, ids));
  return ids;
}

async function insertWatcher(
  instrumentId: string,
  hostname: string
): Promise<string> {
  const [w] = await getTestDb()
    .insert(watchers)
    .values({
      instrumentId,
      hostname,
      status: "watching",
      lastHeartbeatAt: new Date(),
    })
    .returning({ id: watchers.id });
  return w.id;
}

describe("Heartbeat — revert upload queue on watcher stop", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("reverts queued files to detected when the watcher reports stopped", async () => {
    const instrumentId = "stop-revert-inst";
    const ids = await seedQueuedRun(instrumentId, "run-1", token);
    const watcherId = await insertWatcher(instrumentId, "lab-pc");

    const res = await api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body: { status: "stopped" },
    });
    expect(res.status).toBe(200);

    const db = getTestDb();
    const rows = await db
      .select({
        status: files.status,
        uploadRequestedAt: files.uploadRequestedAt,
      })
      .from(files)
      .where(inArray(files.id, ids));
    for (const r of rows) {
      expect(r.status).toBe("detected");
      expect(r.uploadRequestedAt).toBeNull();
    }

    const events = await db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.watcherId, watcherId));
    const revert = events.find(
      (e) =>
        (e.details as { kind?: string } | null)?.kind ===
        "upload_requests_cancelled"
    );
    expect(revert).toBeTruthy();
    expect(revert?.eventType).toBe("watcher_stopped");
    expect((revert?.details as { reason?: string }).reason).toBe(
      "watcher_stopped"
    );
    expect(
      (revert?.details as { cancelled_count?: number }).cancelled_count
    ).toBe(2);
  });

  it("records no event when the stopped watcher had nothing queued", async () => {
    const instrumentId = "stop-revert-empty-inst";
    // A run with no files queued for upload.
    await getTestDb().insert(instruments).values({
      id: instrumentId,
      displayName: "Empty instrument",
      status: "active",
    });
    const watcherId = await insertWatcher(instrumentId, "lab-pc");

    const res = await api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body: { status: "stopped" },
    });
    expect(res.status).toBe(200);

    const events = await getTestDb()
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.watcherId, watcherId));
    expect(events).toHaveLength(0);
  });

  it("leaves the queue intact on a normal watching heartbeat", async () => {
    const instrumentId = "stop-revert-watching-inst";
    const ids = await seedQueuedRun(instrumentId, "run-1", token);
    const watcherId = await insertWatcher(instrumentId, "lab-pc");

    const res = await api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body: { status: "watching" },
    });
    expect(res.status).toBe(200);

    const rows = await getTestDb()
      .select({ status: files.status })
      .from(files)
      .where(inArray(files.id, ids));
    for (const r of rows) {
      expect(r.status).toBe("upload_requested");
    }
  });

  it("leaves the queue intact on a registered (startup) heartbeat", async () => {
    const instrumentId = "stop-revert-registered-inst";
    const ids = await seedQueuedRun(instrumentId, "run-1", token);
    const watcherId = await insertWatcher(instrumentId, "lab-pc");

    const res = await api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body: { status: "registered" },
    });
    expect(res.status).toBe(200);

    const db = getTestDb();
    const rows = await db
      .select({ status: files.status })
      .from(files)
      .where(inArray(files.id, ids));
    for (const r of rows) {
      expect(r.status).toBe("upload_requested");
    }

    const events = await db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.watcherId, watcherId));
    expect(events).toHaveLength(0);
  });

  it("reverts queued files when the watcher is deregistered (DELETE)", async () => {
    const instrumentId = "deregister-revert-inst";
    const ids = await seedQueuedRun(instrumentId, "run-1", token);
    const watcherId = await insertWatcher(instrumentId, "lab-pc");

    const res = await api(`/api/v1/watchers/${watcherId}`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(200);

    const db = getTestDb();
    const rows = await db
      .select({
        status: files.status,
        uploadRequestedAt: files.uploadRequestedAt,
      })
      .from(files)
      .where(inArray(files.id, ids));
    for (const r of rows) {
      expect(r.status).toBe("detected");
      expect(r.uploadRequestedAt).toBeNull();
    }

    const events = await db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.watcherId, watcherId));
    const revert = events.find(
      (e) =>
        (e.details as { kind?: string } | null)?.kind ===
        "upload_requests_cancelled"
    );
    expect(revert?.eventType).toBe("watcher_stopped");
    expect((revert?.details as { reason?: string }).reason).toBe(
      "watcher_deregistered"
    );
  });
});
