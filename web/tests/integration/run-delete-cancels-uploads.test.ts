import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  watcherEventsListResponse,
  watcherUploadQueueResponse,
} from "@/lib/api/openapi";
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

  it("lists the event and filters the event list by its type", async () => {
    const instrumentId = "cancel-list-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a"]);
    await markRequested([run.fileIds.a]);

    await deleteRun(token, instrumentId, "run-1");

    const res = await api(
      `/api/v1/watchers/${watcherId}/events?event_type=upload_requests_cancelled`,
      { token }
    );
    expect(res.status).toBe(200);
    const { data } = watcherEventsListResponse.parse(await res.json());
    expect(data.map((event) => event.event_type)).toEqual([
      "upload_requests_cancelled",
    ]);
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

// Requests that overlap with a delete. Each test holds a lock in its own
// transaction, so a request waits at a known step, and changes the database
// while the request waits. That makes the order of events fixed.

type TestTx = Parameters<
  Parameters<ReturnType<typeof getTestDb>["transaction"]>[0]
>[0];

// Waits until at least `count` database sessions are waiting for a lock.
async function waitForBlockedSessions(count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await getTestDb().execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`
    );
    if (result.rows[0].n >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fewer than ${count} sessions waited for a lock`);
}

// Takes a lock in a transaction, starts the requests, and waits until each of
// them is stuck on a lock. Then it runs `during` in the same transaction and
// commits, which lets the requests go on. Returns their responses.
async function holdLockWhile(steps: {
  lock: (tx: TestTx) => Promise<unknown>;
  start: () => Promise<Response>[];
  during?: (tx: TestTx) => Promise<unknown>;
}): Promise<Response[]> {
  const { pending } = await getTestDb().transaction(async (tx) => {
    await steps.lock(tx);
    const started = steps.start();
    await waitForBlockedSessions(started.length);
    await steps.during?.(tx);
    // An object, because a bare promise would be awaited before the commit.
    return { pending: started };
  });
  return await Promise.all(pending);
}

const lockFile = (id: number) => (tx: TestTx) =>
  tx.execute(sql`select id from files where id = ${id} for update`);
const lockFilesTable = (tx: TestTx) =>
  tx.execute(sql`lock table files in access exclusive mode`);

describe("Deleting a run while other requests are in flight", () => {
  let token: string;
  let userId: string;

  beforeAll(async () => {
    await resetDb();
    ({ token, userId } = await seedTestUser());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const runPath = (instrumentId: string, runId: string) =>
    `/api/v1/instruments/${instrumentId}/runs/${runId}`;
  const sendDelete = (instrumentId: string, runId: string) =>
    api(runPath(instrumentId, runId), { method: "DELETE", token });

  it("locks the files before the run, so a delete and a revert don't deadlock", async () => {
    const instrumentId = "race-order-inst";
    await seedInstrument(instrumentId);
    await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a"]);
    await markRequested([run.fileIds.a]);

    const [res] = await holdLockWhile({
      // This transaction plays another revert of the instrument's requests.
      // It has locked the file and goes on to touch the run. If the delete had
      // locked the run first, the two would wait for each other.
      lock: lockFile(run.fileIds.a),
      start: () => [sendDelete(instrumentId, "run-1")],
      during: async (tx) => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx
          .update(instrumentRuns)
          .set({ updatedAt: new Date() })
          .where(eq(instrumentRuns.id, run.runUuid));
      },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).already_applied).toBe(false);
    expect((await readFile(run.fileIds.a)).status).toBe("detected");
  });

  it("changes nothing when another delete wins the race", async () => {
    const instrumentId = "race-lost-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a"]);
    await markRequested([run.fileIds.a]);
    const winnerDeletedAt = new Date("2026-01-01T00:00:00.000Z");

    const [res] = await holdLockWhile({
      // The winner has marked the run deleted but has not committed yet. The
      // loser waits to touch the run, and goes on once the winner commits.
      lock: (tx) =>
        tx
          .update(instrumentRuns)
          .set({ deletedAt: winnerDeletedAt, deletedBy: userId })
          .where(eq(instrumentRuns.id, run.runUuid)),
      start: () => [sendDelete(instrumentId, "run-1")],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_applied).toBe(true);
    expect(new Date(body.deleted_at)).toEqual(winnerDeletedAt);
    expect(body.deleted_by).toBe(userId);
    expect(body.deleted_by_token).toBeNull();

    // The loser did not overwrite who deleted the run, and its changes to the
    // file and the event log were rolled back.
    const [row] = await getTestDb()
      .select({
        deletedAt: instrumentRuns.deletedAt,
        deletedBy: instrumentRuns.deletedBy,
        deletedByToken: instrumentRuns.deletedByToken,
      })
      .from(instrumentRuns)
      .where(eq(instrumentRuns.id, run.runUuid));
    expect(row).toEqual({
      deletedAt: winnerDeletedAt,
      deletedBy: userId,
      deletedByToken: null,
    });
    expect((await readFile(run.fileIds.a)).status).toBe("upload_requested");
    expect(await readCancelEvents(watcherId)).toHaveLength(0);
  });

  it("lets only one of two overlapping deletes cancel the requests", async () => {
    const instrumentId = "race-twins-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a", "b"]);
    await markRequested(Object.values(run.fileIds));

    const responses = await holdLockWhile({
      // Both deletes have looked up the run, which is still live, and wait to
      // touch the files. They then run at the same time.
      lock: lockFilesTable,
      start: () => [
        sendDelete(instrumentId, "run-1"),
        sendDelete(instrumentId, "run-1"),
      ],
    });

    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((res) => res.json()));
    expect(bodies.filter((body) => !body.already_applied)).toHaveLength(1);
    expect(bodies[0].deleted_at).toBe(bodies[1].deleted_at);

    for (const id of Object.values(run.fileIds)) {
      expect((await readFile(id)).status).toBe("detected");
    }
    const events = await readCancelEvents(watcherId);
    expect(events).toHaveLength(1);
    expect(
      (events[0].details as { cancelled_count: number }).cancelled_count
    ).toBe(2);
  });

  it("changes nothing when a request for upload-all loses to a delete", async () => {
    const instrumentId = "race-all-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a", "b"]);

    const [res] = await holdLockWhile({
      // The request has checked that the run is live and waits to queue the
      // files. The run is deleted before it can.
      lock: lockFilesTable,
      start: () => [
        api(`${runPath(instrumentId, "run-1")}/request-upload-all`, {
          method: "POST",
          token,
        }),
      ],
      during: (tx) =>
        tx
          .update(instrumentRuns)
          .set({ deletedAt: new Date() })
          .where(eq(instrumentRuns.id, run.runUuid)),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    for (const id of Object.values(run.fileIds)) {
      const file = await readFile(id);
      expect(file.status).toBe("detected");
      expect(file.uploadRequestedAt).toBeNull();
    }
    expect(await readQueue(token, watcherId)).toEqual([]);
  });

  it("changes nothing when a request for chosen files loses to a delete", async () => {
    const instrumentId = "race-some-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a", "b"]);

    const [res] = await holdLockWhile({
      lock: lockFilesTable,
      start: () => [
        api(`${runPath(instrumentId, "run-1")}/request-upload`, {
          method: "POST",
          token,
          body: { file_ids: Object.values(run.fileIds) },
        }),
      ],
      during: (tx) =>
        tx
          .update(instrumentRuns)
          .set({ deletedAt: new Date() })
          .where(eq(instrumentRuns.id, run.runUuid)),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(
      "Cannot request uploads for a soft-deleted run"
    );
    for (const id of Object.values(run.fileIds)) {
      expect((await readFile(id)).status).toBe("detected");
    }
    expect(await readQueue(token, watcherId)).toEqual([]);
  });

  it("does not queue a file that stopped being detected while the request ran", async () => {
    const instrumentId = "race-status-inst";
    await seedInstrument(instrumentId);
    await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a", "b"]);

    const [res] = await holdLockWhile({
      lock: lockFile(run.fileIds.a),
      start: () => [
        api(`${runPath(instrumentId, "run-1")}/request-upload`, {
          method: "POST",
          token,
          body: { file_ids: [run.fileIds.a, run.fileIds.b] },
        }),
      ],
      // The file is uploaded by another path while the request waits.
      during: (tx) =>
        tx
          .update(files)
          .set({ status: "uploaded", uploadedAt: new Date() })
          .where(eq(files.id, run.fileIds.a)),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    // Without the status condition, the upload request would turn the
    // uploaded file back into a requested one.
    expect((await readFile(run.fileIds.a)).status).toBe("uploaded");
  });

  it("accepts two requests for the same files at the same time", async () => {
    const instrumentId = "race-twice-inst";
    await seedInstrument(instrumentId);
    const watcherId = await seedWatcher(instrumentId);
    const run = await seedRun(token, instrumentId, "run-1", ["a"]);
    const request = () =>
      api(`${runPath(instrumentId, "run-1")}/request-upload`, {
        method: "POST",
        token,
        body: { file_ids: [run.fileIds.a] },
      });

    const responses = await holdLockWhile({
      lock: lockFile(run.fileIds.a),
      start: () => [request(), request()],
    });

    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    expect((await readFile(run.fileIds.a)).status).toBe("upload_requested");
    expect(await readQueue(token, watcherId)).toEqual(["a"]);
  });
});
