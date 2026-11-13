import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { watcherUploadQueueResponse } from "@/lib/api/openapi";
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
  getMcpAccessToken,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// Deleting a run cancels the uploads that were requested for its files. A
// deleted run refuses uploads, so without this the files stayed in the
// watcher's queue, which it could neither upload nor cancel. The files go back
// to `detected`, and the instrument's active watcher gets an
// `upload_requests_cancelled` event.

const MCP_HEADERS = { Accept: "application/json, text/event-stream" };

interface SeededRun {
  // Test file names to file IDs.
  fileIds: Record<string, number>;
  runId: string;
  runUuid: string;
}

async function seedInstrument(instrumentId: string): Promise<void> {
  await getTestDb()
    .insert(instruments)
    .values({
      id: instrumentId,
      displayName: `Instrument ${instrumentId}`,
      status: "active",
    });
}

async function seedWatcher(
  instrumentId: string,
  opts: { deregistered?: boolean } = {}
): Promise<string> {
  const [watcher] = await getTestDb()
    .insert(watchers)
    .values({
      instrumentId,
      hostname: "lab-pc",
      status: "watching",
      lastHeartbeatAt: new Date(),
      deletedAt: opts.deregistered ? new Date() : null,
    })
    .returning({ id: watchers.id });
  return watcher.id;
}

// Creates a run through the API with one detected file per name.
async function seedRun(
  token: string,
  instrumentId: string,
  runId: string,
  names: string[]
): Promise<SeededRun> {
  const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
    method: "POST",
    token,
    body: {
      run_id: runId,
      source: "watcher",
      detected_files: names.map((name) => ({
        relative_path: name,
        filename: name,
        size_bytes: 1000,
      })),
    },
  });
  expect(res.status).toBeLessThan(300);

  const db = getTestDb();
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
    .select({ id: files.id, filename: files.filename })
    .from(files)
    .where(eq(files.instrumentRunId, run.id));
  return {
    runId,
    runUuid: run.id,
    fileIds: Object.fromEntries(rows.map((row) => [row.filename, row.id])),
  };
}

// Marks files as requested for upload, as the request-upload endpoints do.
async function markRequested(ids: number[]): Promise<void> {
  await getTestDb()
    .update(files)
    .set({ status: "upload_requested", uploadRequestedAt: new Date() })
    .where(inArray(files.id, ids));
}

async function readFile(id: number) {
  const [row] = await getTestDb()
    .select({
      status: files.status,
      uploadRequestedAt: files.uploadRequestedAt,
      uploadedAt: files.uploadedAt,
      deletedAt: files.deletedAt,
    })
    .from(files)
    .where(eq(files.id, id));
  return row;
}

// The names of the files in the watcher's upload queue.
async function readQueue(token: string, watcherId: string): Promise<string[]> {
  const res = await api(`/api/v1/watchers/${watcherId}/upload-queue`, {
    token,
  });
  expect(res.status).toBe(200);
  const body = watcherUploadQueueResponse.parse(await res.json());
  return body.files.map((file) => file.filename).sort();
}

async function readCancelEvents(watcherId: string) {
  return await getTestDb()
    .select()
    .from(watcherEvents)
    .where(
      and(
        eq(watcherEvents.watcherId, watcherId),
        eq(watcherEvents.eventType, "upload_requests_cancelled")
      )
    );
}

async function deleteRun(token: string, instrumentId: string, runId: string) {
  const res = await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
    method: "DELETE",
    token,
  });
  expect(res.status).toBe(200);
  return await res.json();
}

async function restoreRun(token: string, instrumentId: string, runId: string) {
  const res = await api(
    `/api/v1/instruments/${instrumentId}/runs/${runId}/restore`,
    { method: "POST", token }
  );
  expect(res.status).toBe(200);
  return await res.json();
}

async function parseSseResponse(res: Response) {
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data: ".length)));
  return events.at(-1);
}

async function callMcpTool(
  bearer: string,
  name: string,
  args: Record<string, unknown>
) {
  const res = await api("/mcp/v1", {
    method: "POST",
    token: bearer,
    headers: MCP_HEADERS,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(res.status).toBe(200);
  const data = await parseSseResponse(res);
  expect(data.result.isError).toBeFalsy();
  return JSON.parse(data.result.content[0].text);
}

describe("Deleting a run cancels its requested uploads", () => {
  let token: string;
  let mcpToken: string;

  beforeAll(async () => {
    await resetDb();
    const user = await seedTestUser();
    token = user.token;
    mcpToken = await getMcpAccessToken(user.userId);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("reverts the run's requested files and records an event on the watcher", async () => {
    const instrumentId = "cancel-basic-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a", "b", "c"]);
    await markRequested([run.fileIds.a, run.fileIds.b]);

    const body = await deleteRun(token, instrumentId, "run-1");
    expect(body.already_applied).toBe(false);

    for (const name of ["a", "b"]) {
      const file = await readFile(run.fileIds[name]);
      expect(file.status).toBe("detected");
      expect(file.uploadRequestedAt).toBeNull();
    }
    // `c` was never requested, so nothing changed for it.
    expect((await readFile(run.fileIds.c)).status).toBe("detected");

    const events = await readCancelEvents(watcherId);
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe(
      "Cancelled 2 requested uploads because run run-1 was deleted"
    );
    expect(events[0].details).toEqual({
      kind: "upload_requests_cancelled",
      reason: "run_deleted",
      run_id: "run-1",
      cancelled_count: 2,
    });
  });

  it("says 'upload' when only one file was cancelled", async () => {
    const instrumentId = "cancel-single-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a", "b"]);
    await markRequested([run.fileIds.a]);

    await deleteRun(token, instrumentId, "run-1");

    const [event] = await readCancelEvents(watcherId);
    expect(event.message).toBe(
      "Cancelled 1 requested upload because run run-1 was deleted"
    );
  });

  it("takes the files out of the watcher's upload queue", async () => {
    const instrumentId = "cancel-queue-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const doomed = await seedRun(token, instrumentId, "doomed", ["a", "b"]);
    await markRequested(Object.values(doomed.fileIds));

    expect(await readQueue(token, watcherId)).toEqual(["a", "b"]);
    await deleteRun(token, instrumentId, "doomed");
    expect(await readQueue(token, watcherId)).toEqual([]);
  });

  it("leaves the requests of another run and of another instrument alone", async () => {
    const instrumentId = "cancel-scope-inst";
    const otherInstrumentId = "cancel-scope-other-inst";
    await seedInstrument(instrumentId);
    await seedInstrument(otherInstrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const otherWatcherId = await seedWatcher(otherInstrumentId);

    const doomed = await seedRun(token, instrumentId, "doomed", ["doomed.csv"]);
    const sibling = await seedRun(token, instrumentId, "sibling", [
      "sibling.csv",
    ]);
    // The same run ID on another instrument is a different run.
    const namesake = await seedRun(token, otherInstrumentId, "doomed", [
      "namesake.csv",
    ]);
    await markRequested([
      ...Object.values(doomed.fileIds),
      ...Object.values(sibling.fileIds),
      ...Object.values(namesake.fileIds),
    ]);

    await deleteRun(token, instrumentId, "doomed");

    for (const run of [sibling, namesake]) {
      const file = await readFile(Object.values(run.fileIds)[0]);
      expect(file.status).toBe("upload_requested");
      expect(file.uploadRequestedAt).not.toBeNull();
    }
    expect(await readQueue(token, watcherId)).toEqual(["sibling.csv"]);
    expect(await readQueue(token, otherWatcherId)).toEqual(["namesake.csv"]);
    expect(await readCancelEvents(otherWatcherId)).toHaveLength(0);
  });

  it("leaves uploaded and dismissed files alone", async () => {
    const instrumentId = "cancel-keep-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", [
      "queued",
      "uploaded",
      "dismissed",
    ]);
    const uploadedAt = new Date("2026-01-01T00:00:00.000Z");
    const dismissedAt = new Date("2026-01-02T00:00:00.000Z");
    const db = getTestDb();
    await markRequested([run.fileIds.queued]);
    await db
      .update(files)
      .set({ status: "uploaded", uploadedAt })
      .where(eq(files.id, run.fileIds.uploaded));
    // A file someone dismissed while it was requested, so only the dismissal
    // keeps it out of the cancellation.
    await db
      .update(files)
      .set({
        status: "upload_requested",
        uploadRequestedAt: new Date(),
        deletedAt: dismissedAt,
      })
      .where(eq(files.id, run.fileIds.dismissed));

    await deleteRun(token, instrumentId, "run-1");

    expect((await readFile(run.fileIds.queued)).status).toBe("detected");
    const uploaded = await readFile(run.fileIds.uploaded);
    expect(uploaded.status).toBe("uploaded");
    expect(uploaded.uploadedAt).toEqual(uploadedAt);
    const dismissed = await readFile(run.fileIds.dismissed);
    expect(dismissed.status).toBe("upload_requested");
    expect(dismissed.uploadRequestedAt).not.toBeNull();
    expect(dismissed.deletedAt).toEqual(dismissedAt);

    const [event] = await readCancelEvents(watcherId);
    expect((event.details as { cancelled_count: number }).cancelled_count).toBe(
      1
    );
  });

  it("leaves the files detected after a restore, and a new request queues them again", async () => {
    const instrumentId = "cancel-restore-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a", "b"]);
    await markRequested(Object.values(run.fileIds));

    await deleteRun(token, instrumentId, "run-1");
    const restored = await restoreRun(token, instrumentId, "run-1");
    expect(restored.already_applied).toBe(false);

    for (const id of Object.values(run.fileIds)) {
      const file = await readFile(id);
      expect(file.status).toBe("detected");
      expect(file.uploadRequestedAt).toBeNull();
    }
    expect(await readQueue(token, watcherId)).toEqual([]);

    const request = await api(
      `/api/v1/instruments/${instrumentId}/runs/run-1/request-upload-all`,
      { method: "POST", token }
    );
    expect(request.status).toBe(200);
    expect(await readQueue(token, watcherId)).toEqual(["a", "b"]);
  });

  it("records nothing more when the run is deleted a second time", async () => {
    const instrumentId = "cancel-twice-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a"]);
    await markRequested([run.fileIds.a]);

    const first = await deleteRun(token, instrumentId, "run-1");
    expect(first.already_applied).toBe(false);
    const second = await deleteRun(token, instrumentId, "run-1");
    expect(second.already_applied).toBe(true);

    expect(await readCancelEvents(watcherId)).toHaveLength(1);
  });

  it("records no event when nothing was requested", async () => {
    const instrumentId = "cancel-none-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    await seedRun(token, instrumentId, "run-1", ["a"]);

    await deleteRun(token, instrumentId, "run-1");

    expect(await readCancelEvents(watcherId)).toHaveLength(0);
  });

  it("reverts the files but records no event when the instrument has no active watcher", async () => {
    const noWatcherId = "cancel-no-watcher-inst";
    const goneWatcherId = "cancel-gone-watcher-inst";
    await seedInstrument(noWatcherId);
    await seedInstrument(goneWatcherId);
    const deregisteredId = await seedWatcher(goneWatcherId, {
      deregistered: true,
    });
    const noWatcherRun = await seedRun(token, noWatcherId, "no-watcher-run", [
      "a",
    ]);
    const goneWatcherRun = await seedRun(
      token,
      goneWatcherId,
      "gone-watcher-run",
      ["a"]
    );
    await markRequested([noWatcherRun.fileIds.a, goneWatcherRun.fileIds.a]);

    await deleteRun(token, noWatcherId, "no-watcher-run");
    await deleteRun(token, goneWatcherId, "gone-watcher-run");

    expect((await readFile(noWatcherRun.fileIds.a)).status).toBe("detected");
    expect((await readFile(goneWatcherRun.fileIds.a)).status).toBe("detected");
    // The deregistered watcher gets no event, and no event names either run.
    expect(await readCancelEvents(deregisteredId)).toHaveLength(0);
    const events = await getTestDb()
      .select({ details: watcherEvents.details })
      .from(watcherEvents)
      .where(eq(watcherEvents.eventType, "upload_requests_cancelled"));
    const runIds = events.map((e) => (e.details as { run_id: string }).run_id);
    expect(runIds).not.toContain("no-watcher-run");
    expect(runIds).not.toContain("gone-watcher-run");
  });

  it("stops listing a requested file whose run is deleted, even if the delete did not revert it", async () => {
    const instrumentId = "cancel-filter-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const live = await seedRun(token, instrumentId, "live", ["live.csv"]);
    const stuck = await seedRun(token, instrumentId, "stuck", ["stuck.csv"]);
    await markRequested([
      ...Object.values(live.fileIds),
      ...Object.values(stuck.fileIds),
    ]);
    // A run deleted before this release, with its request left in place.
    await getTestDb()
      .update(instrumentRuns)
      .set({ deletedAt: new Date() })
      .where(eq(instrumentRuns.id, stuck.runUuid));

    expect(await readQueue(token, watcherId)).toEqual(["live.csv"]);
  });

  it("cancels the requests when the run is deleted through MCP", async () => {
    const instrumentId = "cancel-mcp-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a", "b"]);
    await markRequested(Object.values(run.fileIds));

    const result = await callMcpTool(mcpToken, "delete_run", {
      instrumentId,
      runId: "run-1",
    });
    expect(result.alreadyApplied).toBe(false);

    for (const id of Object.values(run.fileIds)) {
      expect((await readFile(id)).status).toBe("detected");
    }
    expect(await readQueue(token, watcherId)).toEqual([]);
    expect(await readCancelEvents(watcherId)).toHaveLength(1);
  });

  it("leaves files of deleted runs out of the pending upload count", async () => {
    const instrumentId = "cancel-count-inst";
    await seedInstrument(instrumentId);
    await seedWatcher(instrumentId);
    const doomed = await seedRun(token, instrumentId, "doomed", ["a", "b"]);
    await seedRun(token, instrumentId, "kept", ["c"]);
    await markRequested(Object.values(doomed.fileIds));

    const pendingCount = async (): Promise<number> => {
      const status = await callMcpTool(mcpToken, "get_system_status", {});
      const row = status.instruments.find(
        (instrument: { id: string }) => instrument.id === instrumentId
      );
      return row.filesPendingUpload;
    };

    expect(await pendingCount()).toBe(3);
    // The delete turns the requested files back to `detected`, which still
    // counts as pending, so only the deleted-run filter can drop them.
    await deleteRun(token, instrumentId, "doomed");
    expect(await pendingCount()).toBe(1);
    await restoreRun(token, instrumentId, "doomed");
    expect(await pendingCount()).toBe(3);
  });
});

// The dashboard's "Pending uploads" card counts the files of every active
// instrument, so these tests get the database to themselves.
describe("Dashboard pending uploads after a run is deleted", () => {
  let token: string;
  let cookie: string;

  beforeAll(async () => {
    await resetDb();
    const user = await seedTestUser();
    token = user.token;
    cookie = await seedSessionCookie(user.userId);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // The number on the card and the line under it, read from the page HTML.
  async function readPendingCard(): Promise<{ count: string; note: string }> {
    const res = await api("/", {
      headers: { Accept: "text/html", Cookie: cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(
      /Pending uploads<\/p><p[^>]*>([^<]*)<\/p><p[^>]*>([^<]*)<\/p>/
    );
    if (!match) {
      throw new Error("The Pending uploads card is not in the page");
    }
    return { count: match[1], note: match[2] };
  }

  it("leaves the files of a deleted run out of the card", async () => {
    const instrumentId = "dashboard-count-inst";
    await seedInstrument(instrumentId);
    await seedWatcher(instrumentId);
    const doomed = await seedRun(token, instrumentId, "doomed", ["a", "b"]);
    await seedRun(token, instrumentId, "kept", ["c"]);
    await markRequested(Object.values(doomed.fileIds));

    expect((await readPendingCard()).count).toBe("3");
    await deleteRun(token, instrumentId, "doomed");
    expect((await readPendingCard()).count).toBe("1");
    await deleteRun(token, instrumentId, "kept");
    expect(await readPendingCard()).toEqual({
      count: "0",
      note: "Upload queue is clear",
    });
  });
});
