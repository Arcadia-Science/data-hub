import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { WATCHER_VERSION_HEADER } from "@/lib/api/watcher-compat";
import { revertPendingUploadRequests } from "@/lib/api/watchers";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// "Last Updated" reads instrument_runs.updated_at. A new file, a "Ran By"
// change, or a comment moves it; a repeat report or repeat claim does not,
// unless the report carries an earlier file time. Sorting stays stable when
// several runs share one timestamp.
const watcherHeaders = { [WATCHER_VERSION_HEADER]: "1.1.0" };
const fileCreatedAt = "2024-06-01T12:00:00.000Z";

function reportedFile(filename: string, createdAt = fileCreatedAt) {
  return {
    relative_path: filename,
    filename,
    size_bytes: 1,
    file_created_at: createdAt,
  };
}

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
    detectedFiles: Array<{
      filename: string;
      file_created_at?: string;
    }> = [],
    headers?: Record<string, string>
  ) {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      headers,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: detectedFiles.map((file) => ({
          relative_path: file.filename,
          filename: file.filename,
          size_bytes: 1,
          ...(file.file_created_at
            ? { file_created_at: file.file_created_at }
            : {}),
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

  async function readAcquiredAt(instrumentId: string, runId: string) {
    const [row] = await getTestDb()
      .select({ acquiredAt: instrumentRuns.acquiredAt })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          eq(instrumentRuns.runId, runId)
        )
      );
    if (!row?.acquiredAt) {
      throw new Error(`Run ${instrumentId}/${runId} has no acquired_at`);
    }
    return row.acquiredAt;
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

  it.each([
    {
      label: "an older watcher",
      headers: undefined,
      instrumentId: "updated-at-detected",
    },
    {
      label: "the current watcher",
      headers: watcherHeaders,
      instrumentId: "updated-at-detected-current",
    },
  ])("bumps updated_at for a new file and not for a repeat report from $label", async ({
    headers,
    instrumentId,
  }) => {
    const runId = "detect-run";
    await createInstrument(instrumentId);
    await createRun(
      instrumentId,
      runId,
      [{ filename: "a.csv", file_created_at: fileCreatedAt }],
      headers
    );

    const past = new Date("2020-02-01T00:00:00.000Z");
    await pinUpdatedAt(instrumentId, runId, past);

    const added = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      {
        method: "PATCH",
        token,
        headers,
        body: {
          detected_files: [reportedFile("a.csv"), reportedFile("b.csv")],
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
        headers,
        body: {
          detected_files: [reportedFile("a.csv"), reportedFile("b.csv")],
        },
      }
    );
    expect(repeated.status).toBe(200);
    const afterRepeat = await readUpdatedAt(instrumentId, runId);
    expect(afterRepeat.toISOString()).toBe(past.toISOString());
  });

  it("moves acquired_at and updated_at when a repeat report has an earlier file time", async () => {
    const instrumentId = "updated-at-earlier";
    const runId = "earlier-run";
    const stored = "2024-06-01T12:00:00.000Z";
    const earlier = "2024-01-01T00:00:00.000Z";
    await createInstrument(instrumentId);
    await createRun(
      instrumentId,
      runId,
      [{ filename: "a.csv", file_created_at: stored }],
      watcherHeaders
    );
    expect((await readAcquiredAt(instrumentId, runId)).toISOString()).toBe(
      stored
    );

    const past = new Date("2020-04-01T00:00:00.000Z");
    await pinUpdatedAt(instrumentId, runId, past);

    const res = await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      method: "PATCH",
      token,
      headers: watcherHeaders,
      body: {
        detected_files: [reportedFile("a.csv", earlier)],
      },
    });
    expect(res.status).toBe(200);

    expect((await readAcquiredAt(instrumentId, runId)).toISOString()).toBe(
      earlier
    );
    const updated = await readUpdatedAt(instrumentId, runId);
    expect(updated.getTime()).toBeGreaterThan(past.getTime());
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

  it("moves updated_at on claim and unclaim, but not on a repeat claim", async () => {
    const instrumentId = "updated-at-attribution";
    const runId = "claim-run";
    await createInstrument(instrumentId);
    await createRun(instrumentId, runId);

    const attributionsUrl = `/api/v1/instruments/${instrumentId}/runs/${runId}/attributions/me`;
    const past = new Date("2020-05-01T00:00:00.000Z");

    await pinUpdatedAt(instrumentId, runId, past);
    const claimed = await api(attributionsUrl, { method: "PUT", token });
    expect(claimed.status).toBe(200);
    const afterClaim = await readUpdatedAt(instrumentId, runId);
    expect(afterClaim.getTime()).toBeGreaterThan(past.getTime());

    // Re-claiming stores no new row, so the time stays put.
    await pinUpdatedAt(instrumentId, runId, past);
    const reclaimed = await api(attributionsUrl, { method: "PUT", token });
    expect(reclaimed.status).toBe(200);
    expect((await readUpdatedAt(instrumentId, runId)).toISOString()).toBe(
      past.toISOString()
    );

    await pinUpdatedAt(instrumentId, runId, past);
    const unclaimed = await api(attributionsUrl, { method: "DELETE", token });
    expect(unclaimed.status).toBe(200);
    const afterUnclaim = await readUpdatedAt(instrumentId, runId);
    expect(afterUnclaim.getTime()).toBeGreaterThan(past.getTime());

    // Unclaiming with no attribution left is a no-op too.
    await pinUpdatedAt(instrumentId, runId, past);
    const unclaimedAgain = await api(attributionsUrl, {
      method: "DELETE",
      token,
    });
    expect(unclaimedAgain.status).toBe(200);
    expect((await readUpdatedAt(instrumentId, runId)).toISOString()).toBe(
      past.toISOString()
    );
  });

  it("moves updated_at when a comment is added, edited, or deleted", async () => {
    const instrumentId = "updated-at-comments";
    const runId = "comment-run";
    await createInstrument(instrumentId);
    await createRun(instrumentId, runId);

    const commentsUrl = `/api/v1/instruments/${instrumentId}/runs/${runId}/comments`;
    const past = new Date("2020-06-01T00:00:00.000Z");

    await pinUpdatedAt(instrumentId, runId, past);
    const created = await api(commentsUrl, {
      method: "POST",
      token,
      body: { body: "first pass looked clean" },
    });
    expect(created.status).toBe(201);
    const commentId = (await created.json()).id as string;
    const afterCreate = await readUpdatedAt(instrumentId, runId);
    expect(afterCreate.getTime()).toBeGreaterThan(past.getTime());

    await pinUpdatedAt(instrumentId, runId, past);
    const edited = await api(`${commentsUrl}/${commentId}`, {
      method: "PATCH",
      token,
      body: { body: "second pass found a bubble" },
    });
    expect(edited.status).toBe(200);
    const afterEdit = await readUpdatedAt(instrumentId, runId);
    expect(afterEdit.getTime()).toBeGreaterThan(past.getTime());

    await pinUpdatedAt(instrumentId, runId, past);
    const deleted = await api(`${commentsUrl}/${commentId}`, {
      method: "DELETE",
      token,
    });
    expect(deleted.status).toBe(200);
    const afterDelete = await readUpdatedAt(instrumentId, runId);
    expect(afterDelete.getTime()).toBeGreaterThan(past.getTime());
  });
});
