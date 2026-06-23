import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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

// The cron staleness sweep reverts files stuck in `upload_requested` once an
// instrument has had no online watcher for longer than the grace window:
// ungraceful watcher death and watchers deregistered while files were queued.

// Must match CRON_SECRET set on the test server in global-setup.ts.
const CRON_SECRET = "test-cron-secret";

const MINUTE_MS = 60 * 1000;

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

function runSweep(authHeader?: string): Promise<Response> {
  return api("/api/cron/upload-queue-sweep", {
    headers: authHeader ? { Authorization: authHeader } : {},
  });
}

async function statuses(ids: number[]): Promise<string[]> {
  const rows = await getTestDb()
    .select({ status: files.status })
    .from(files)
    .where(inArray(files.id, ids));
  return rows.map((r) => r.status);
}

describe("Cron — upload queue staleness sweep", () => {
  let token: string;

  beforeEach(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("rejects requests without the cron secret", async () => {
    expect((await runSweep()).status).toBe(401);
    expect((await runSweep("Bearer wrong")).status).toBe(401);
  });

  it("reverts queued files when the sole watcher is stale beyond the grace window", async () => {
    const instrumentId = "sweep-stale-inst";
    const ids = await seedQueuedRun(instrumentId, "run-1", token);
    const [w] = await getTestDb()
      .insert(watchers)
      .values({
        instrumentId,
        hostname: "dead-pc",
        status: "watching",
        // 20 minutes ago — past the 15-minute revert grace.
        lastHeartbeatAt: new Date(Date.now() - 20 * MINUTE_MS),
      })
      .returning({ id: watchers.id });

    const res = await runSweep(`Bearer ${CRON_SECRET}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.swept_instruments).toBe(1);
    expect(data.reverted_files).toBe(2);

    expect(await statuses(ids)).toEqual(["detected", "detected"]);

    const events = await getTestDb()
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.watcherId, w.id));
    const revert = events.find(
      (e) =>
        (e.details as { kind?: string } | null)?.kind ===
        "upload_requests_cancelled"
    );
    expect(revert?.eventType).toBe("error");
    expect((revert?.details as { reason?: string }).reason).toBe(
      "watcher_offline_sweep"
    );
  });

  it("does not revert when a watcher is online", async () => {
    const instrumentId = "sweep-online-inst";
    const ids = await seedQueuedRun(instrumentId, "run-1", token);
    await getTestDb().insert(watchers).values({
      instrumentId,
      hostname: "online-pc",
      status: "watching",
      lastHeartbeatAt: new Date(),
    });

    const res = await runSweep(`Bearer ${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect((await res.json()).reverted_files).toBe(0);
    expect(await statuses(ids)).toEqual([
      "upload_requested",
      "upload_requested",
    ]);
  });

  it("does not revert within the grace window even if past the online threshold", async () => {
    const instrumentId = "sweep-grace-inst";
    const ids = await seedQueuedRun(instrumentId, "run-1", token);
    await getTestDb()
      .insert(watchers)
      .values({
        instrumentId,
        hostname: "blip-pc",
        status: "watching",
        // 10 minutes ago — offline per the 5-min threshold but still inside
        // the 15-min revert grace, so the sweep must leave the queue alone.
        lastHeartbeatAt: new Date(Date.now() - 10 * MINUTE_MS),
      });

    const res = await runSweep(`Bearer ${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect((await res.json()).reverted_files).toBe(0);
    expect(await statuses(ids)).toEqual([
      "upload_requested",
      "upload_requested",
    ]);
  });

  it("reverts when the only watcher was deregistered after queueing", async () => {
    const instrumentId = "sweep-deregistered-inst";
    const ids = await seedQueuedRun(instrumentId, "run-1", token);
    const [w] = await getTestDb()
      .insert(watchers)
      .values({
        instrumentId,
        hostname: "removed-pc",
        status: "watching",
        lastHeartbeatAt: new Date(),
        // Soft-deleted: no active watcher remains for the instrument.
        deletedAt: new Date(),
      })
      .returning({ id: watchers.id });

    const res = await runSweep(`Bearer ${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect((await res.json()).reverted_files).toBe(2);
    expect(await statuses(ids)).toEqual(["detected", "detected"]);

    // The event is still attributed to the (soft-deleted) watcher row.
    const events = await getTestDb()
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.watcherId, w.id));
    expect(events.length).toBe(1);
  });
});
