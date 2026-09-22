import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { revertPendingUploadRequests } from "@/lib/api/watchers";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// "Last Updated" reads instrument_runs.updated_at, so a file change has to
// move that column, and a repeat report of files the run already holds must
// not. Sorting has to stay stable when several runs share one timestamp.
describe("Run updated_at", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function createInstrument(instrumentId: string) {
    await getTestDb().insert(instruments).values({
      id: instrumentId,
      displayName: instrumentId,
      status: "active",
    });
  }

  async function createRun(
    instrumentId: string,
    runId: string,
    detectedFiles: Array<{ filename: string }> = []
  ) {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: detectedFiles.map((file) => ({
          relative_path: file.filename,
          filename: file.filename,
          size_bytes: 1,
        })),
      },
    });
    expect(res.status).toBe(201);
  }

  async function pinUpdatedAt(instrumentId: string, runId: string, at: Date) {
    const db = getTestDb();
    await db
      .update(instrumentRuns)
      .set({ updatedAt: at })
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          eq(instrumentRuns.runId, runId)
        )
      );
    const stored = await readUpdatedAt(instrumentId, runId);
    expect(stored.toISOString()).toBe(at.toISOString());
  }

  async function readUpdatedAt(instrumentId: string, runId: string) {
    const [row] = await getTestDb()
      .select({ updatedAt: instrumentRuns.updatedAt })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          eq(instrumentRuns.runId, runId)
        )
      );
    if (!row) {
      throw new Error(`Run ${instrumentId}/${runId} not found`);
    }
    return row.updatedAt;
  }

  it("sorts by updated_at in both directions and breaks ties on id", async () => {
    const instrumentId = "updated-at-sort";
    await createInstrument(instrumentId);
    await createRun(instrumentId, "early");
    await createRun(instrumentId, "tie-a");
    await createRun(instrumentId, "tie-b");

    const earlier = new Date("2019-06-01T00:00:00.000Z");
    const tied = new Date("2021-06-01T00:00:00.000Z");
    await pinUpdatedAt(instrumentId, "early", earlier);
    await pinUpdatedAt(instrumentId, "tie-a", tied);
    await pinUpdatedAt(instrumentId, "tie-b", tied);

    const filters = {
      instrumentId,
      page: 1,
      perPage: 10,
      includeDeleted: false,
      sort: "updated_at",
    };
    const ascending = await buildRunListQuery({ ...filters, order: "asc" });
    const descending = await buildRunListQuery({ ...filters, order: "desc" });

    const ascendingIds = ascending.data.map((row) => row.run_id);
    expect(ascendingIds).toEqual([
      "early",
      expect.any(String),
      expect.any(String),
    ]);
    expect(new Set(ascendingIds.slice(1))).toEqual(new Set(["tie-a", "tie-b"]));
    // Same direction on the id tiebreak, so descending is the reverse.
    expect(descending.data.map((row) => row.run_id)).toEqual(
      [...ascendingIds].reverse()
    );
  });

  it("moves updated_at forward when a file changes status", async () => {
    const instrumentId = "updated-at-file-patch";
    const runId = "patch-run";
    await createInstrument(instrumentId);
    await createRun(instrumentId, runId, [{ filename: "sample.csv" }]);

    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      { token }
    );
    const fileId = (await detail.json()).files[0].id as number;

    const past = new Date("2020-01-01T00:00:00.000Z");
    await pinUpdatedAt(instrumentId, runId, past);

    const res = await api(`/api/v1/files/${fileId}`, {
      method: "PATCH",
      token,
      body: { status: "uploaded" },
    });
    expect(res.status).toBe(200);

    const updated = await readUpdatedAt(instrumentId, runId);
    expect(updated.getTime()).toBeGreaterThan(past.getTime());
  });

  it("bumps updated_at for a new file and not for a repeat report", async () => {
    const instrumentId = "updated-at-detected";
    const runId = "detect-run";
    await createInstrument(instrumentId);
    await createRun(instrumentId, runId, [{ filename: "a.csv" }]);

    const past = new Date("2020-02-01T00:00:00.000Z");
    await pinUpdatedAt(instrumentId, runId, past);

    const added = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      {
        method: "PATCH",
        token,
        body: {
          detected_files: [
            { relative_path: "a.csv", filename: "a.csv", size_bytes: 1 },
            { relative_path: "b.csv", filename: "b.csv", size_bytes: 1 },
          ],
        },
      }
    );
    expect(added.status).toBe(200);
    const afterAdd = await readUpdatedAt(instrumentId, runId);
    expect(afterAdd.getTime()).toBeGreaterThan(past.getTime());

    await pinUpdatedAt(instrumentId, runId, past);
    const repeated = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      {
        method: "PATCH",
        token,
        body: {
          detected_files: [
            { relative_path: "a.csv", filename: "a.csv", size_bytes: 1 },
            { relative_path: "b.csv", filename: "b.csv", size_bytes: 1 },
          ],
        },
      }
    );
    expect(repeated.status).toBe(200);
    const afterRepeat = await readUpdatedAt(instrumentId, runId);
    expect(afterRepeat.toISOString()).toBe(past.toISOString());
  });

  it("bumps every run whose pending upload was reverted", async () => {
    const instrumentId = "updated-at-revert";
    await createInstrument(instrumentId);
    await createRun(instrumentId, "queued-a", [{ filename: "a.csv" }]);
    await createRun(instrumentId, "queued-b", [{ filename: "b.csv" }]);
    await createRun(instrumentId, "idle", [{ filename: "idle.csv" }]);

    const db = getTestDb();
    const queued = await db
      .select({ id: instrumentRuns.id })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          inArray(instrumentRuns.runId, ["queued-a", "queued-b"])
        )
      );
    await db
      .update(files)
      .set({ status: "upload_requested", uploadRequestedAt: new Date() })
      .where(
        inArray(
          files.instrumentRunId,
          queued.map((row) => row.id)
        )
      );

    const past = new Date("2020-03-01T00:00:00.000Z");
    await pinUpdatedAt(instrumentId, "queued-a", past);
    await pinUpdatedAt(instrumentId, "queued-b", past);
    await pinUpdatedAt(instrumentId, "idle", past);

    const reverted = await revertPendingUploadRequests(instrumentId);
    expect(reverted).toHaveLength(2);

    const queuedA = await readUpdatedAt(instrumentId, "queued-a");
    const queuedB = await readUpdatedAt(instrumentId, "queued-b");
    const idle = await readUpdatedAt(instrumentId, "idle");
    expect(queuedA.getTime()).toBeGreaterThan(past.getTime());
    expect(queuedB.getTime()).toBeGreaterThan(past.getTime());
    expect(idle.toISOString()).toBe(past.toISOString());
  });
});
