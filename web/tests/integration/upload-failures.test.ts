import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getInstrumentSummaries } from "@/lib/api/dashboard";
import {
  uploadFailuresResponse,
  watcherUploadQueueResponse,
} from "@/lib/api/openapi";
import {
  files,
  instrumentRuns,
  instruments,
  notifications,
  watcherEvents,
} from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// The file upload states and their transitions (T1–T7 in the ENG-2246 plan):
// a run report marks files the watcher will upload, a request queues a file
// and records who asked, a give-up (POST /watchers/:id/upload-failures) moves
// a still-waiting file to `upload_failed`, and a new request, an upload or a
// dismissal moves it on. Every case the give-up skips is covered, because a
// stale or repeated report must never fail a newer request or log twice.

const instrumentId = "upload-failures-inst";
const otherInstrumentId = "upload-failures-other";

let token: string;
let userId: string;
let watcherId: string;
let otherWatcherId: string;
let runCounter = 0;

const configYaml = (instrument: string, mode: "auto" | "manual") =>
  [
    "version: 1",
    "instrument:",
    `  id: ${instrument}`,
    "  watch_directory: /data",
    `  upload_mode: ${mode}`,
    "  file_patterns:",
    '    - "*.nd2"',
    "",
  ].join("\n");

async function registerWatcher(instrument: string): Promise<string> {
  const reg = await api("/api/v1/watchers/register", {
    method: "POST",
    token,
    body: { instrument_id: instrument, hostname: `${instrument}-pc` },
  });
  const id = (await reg.json()).watcher_id as string;
  await api(`/api/v1/watchers/${id}/config`, {
    method: "PUT",
    token,
    body: {
      config_checksum: "sum",
      config_yaml: configYaml(instrument, "auto"),
    },
  });
  await heartbeat(id, "auto");
  return id;
}

async function heartbeat(id: string, mode: "auto" | "manual") {
  const res = await api(`/api/v1/watchers/${id}/heartbeat`, {
    method: "POST",
    token,
    body: { status: "watching", upload_mode: mode },
  });
  expect(res.status).toBe(200);
}

// A run in `folder/` with the given files. `willUpload` marks them as files
// the watcher uploads on its own.
async function reportRun(
  names: string[],
  options: { willUpload?: boolean; instrument?: string } = {}
): Promise<{ runId: string; ids: Record<string, number> }> {
  runCounter += 1;
  const runId = `run-${runCounter}`;
  const instrument = options.instrument ?? instrumentId;
  const res = await api(`/api/v1/instruments/${instrument}/runs`, {
    method: "POST",
    token,
    body: {
      run_id: runId,
      source: "watcher",
      watcher_id: instrument === instrumentId ? watcherId : otherWatcherId,
      detected_files: names.map((name) => ({
        relative_path: `${runId}/${name}`,
        filename: name,
        size_bytes: 10,
        ...(options.willUpload ? { will_upload: true } : {}),
      })),
    },
  });
  expect(res.status).toBe(201);
  return { runId, ids: await fileIds(instrument, runId) };
}

async function fileIds(
  instrument: string,
  runId: string
): Promise<Record<string, number>> {
  const res = await api(`/api/v1/instruments/${instrument}/runs/${runId}`, {
    token,
  });
  const data = await res.json();
  const map: Record<string, number> = {};
  for (const f of data.files as { id: number; filename: string }[]) {
    map[f.filename] = f.id;
  }
  return map;
}

async function fileRow(id: number) {
  const [row] = await getTestDb().select().from(files).where(eq(files.id, id));
  return row;
}

async function requestUpload(runId: string, ids: number[]) {
  const res = await api(
    `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/request-upload`,
    { method: "POST", token, body: { file_ids: ids } }
  );
  expect(res.status).toBe(200);
}

async function queue(id = watcherId) {
  const res = await api(`/api/v1/watchers/${id}/upload-queue`, { token });
  return watcherUploadQueueResponse.parse(await res.json()).files;
}

async function reportFailures(body: unknown, id = watcherId) {
  const res = await api(`/api/v1/watchers/${id}/upload-failures`, {
    method: "POST",
    token,
    body,
  });
  return res;
}

async function failureEvents(runId: string) {
  const rows = await getTestDb()
    .select()
    .from(watcherEvents)
    .where(
      and(
        eq(watcherEvents.watcherId, watcherId),
        eq(watcherEvents.eventType, "uploads_failed")
      )
    );
  return rows.filter(
    (row) => (row.details as { run_id?: string } | null)?.run_id === runId
  );
}

async function runStatuses(status: string): Promise<string[]> {
  const res = await api(
    `/api/v1/instruments/${instrumentId}/runs?status=${status}&per_page=100`,
    { token }
  );
  const data = await res.json();
  return (data.data as { run_id: string }[]).map((run) => run.run_id);
}

beforeAll(async () => {
  await resetDb();
  ({ token, userId } = await seedTestUser());
  await getTestDb()
    .insert(instruments)
    .values([
      { id: instrumentId, displayName: "Upload Failures", status: "active" },
      { id: otherInstrumentId, displayName: "Other", status: "active" },
    ]);
  watcherId = await registerWatcher(instrumentId);
  otherWatcherId = await registerWatcher(otherInstrumentId);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  // Every test starts with an auto-mode watcher that has checked in.
  await heartbeat(watcherId, "auto");
});

describe("T1: run reports and the auto-upload mark", () => {
  it("marks only the files the watcher says it will upload", async () => {
    const auto = await reportRun(["a.nd2"], { willUpload: true });
    const manual = await reportRun(["b.nd2"]);

    expect((await fileRow(auto.ids["a.nd2"])).autoUploadExpectedAt).not.toBe(
      null
    );
    expect((await fileRow(manual.ids["b.nd2"])).autoUploadExpectedAt).toBe(
      null
    );
    expect(await runStatuses("waiting_upload")).toContain(auto.runId);
    expect(await runStatuses("not_uploaded")).toContain(manual.runId);
    expect(await runStatuses("not_uploaded")).not.toContain(auto.runId);
  });

  it("still reads the deprecated 'pending' filter as both statuses", async () => {
    const auto = await reportRun(["a.nd2"], { willUpload: true });
    const manual = await reportRun(["b.nd2"]);
    const pending = await runStatuses("pending");
    expect(pending).toContain(auto.runId);
    expect(pending).toContain(manual.runId);
  });

  it("keeps files_pending_upload as the sum of waiting and not uploaded", async () => {
    const { runId } = await reportRun(["a.nd2", "b.nd2"]);
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs?search=${runId}`,
      { token }
    );
    const [row] = (await res.json()).data.filter(
      (r: { run_id: string }) => r.run_id === runId
    );
    expect(row.files_not_uploaded).toBe(2);
    expect(row.files_waiting_upload).toBe(0);
    expect(row.files_pending_upload).toBe(2);
  });
});

describe("T2: a request queues the file and records who asked", () => {
  it("sets the requester to the token's creator", async () => {
    const { runId, ids } = await reportRun(["a.nd2"]);
    await requestUpload(runId, [ids["a.nd2"]]);
    const row = await fileRow(ids["a.nd2"]);
    expect(row.status).toBe("upload_requested");
    expect(row.uploadRequestedBy).toBe(userId);
    const queued = (await queue()).find((f) => f.id === ids["a.nd2"]);
    expect(queued?.upload_requested_at).toBe(
      row.uploadRequestedAt?.toISOString()
    );
  });
});

describe("T5: the watcher gives up", () => {
  it("fails a requested file whose request it tried, and logs one event", async () => {
    const { runId, ids } = await reportRun(["a.nd2", "b.nd2"]);
    await requestUpload(runId, [ids["a.nd2"], ids["b.nd2"]]);
    const queued = await queue();
    const items = queued
      .filter((f) => f.run_id === runId)
      .map((f) => ({
        file_id: f.id,
        requested_at: f.upload_requested_at,
        reason: "folder_missing",
      }));

    const res = await reportFailures({ files: items });
    expect(res.status).toBe(200);
    expect(uploadFailuresResponse.parse(await res.json())).toEqual({
      failed: 2,
      skipped: 0,
    });

    const row = await fileRow(ids["a.nd2"]);
    expect(row.status).toBe("upload_failed");
    expect(row.uploadFailureReason).toBe("folder_missing");
    expect(row.uploadFailedAt).not.toBe(null);
    expect(row.errorMessage).toContain(`The folder ${runId} is no longer`);
    expect(row.uploadRequestedAt).toBe(null);
    expect(row.uploadRequestedBy).toBe(null);
    expect((await queue()).some((f) => f.run_id === runId)).toBe(false);

    const events = await failureEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({
      kind: "uploads_failed",
      reason: "folder_missing",
      folder: runId,
      failed_count: 2,
    });
    expect(await runStatuses("upload_failed")).toContain(runId);
  });

  it("skips a repeated report, with no second event", async () => {
    const { runId, ids } = await reportRun(["a.nd2"]);
    await requestUpload(runId, [ids["a.nd2"]]);
    const [item] = (await queue()).filter((f) => f.run_id === runId);
    const body = {
      files: [
        {
          file_id: item.id,
          requested_at: item.upload_requested_at,
          reason: "file_missing",
        },
      ],
    };
    expect(await (await reportFailures(body)).json()).toEqual({
      failed: 1,
      skipped: 0,
    });
    expect(await (await reportFailures(body)).json()).toEqual({
      failed: 0,
      skipped: 1,
    });
    expect(await failureEvents(runId)).toHaveLength(1);
  });

  it("skips a failure of an earlier request once the file is requested again", async () => {
    const { runId, ids } = await reportRun(["a.nd2"]);
    await requestUpload(runId, [ids["a.nd2"]]);
    const [first] = (await queue()).filter((f) => f.run_id === runId);
    await reportFailures({
      files: [
        {
          file_id: first.id,
          requested_at: first.upload_requested_at,
          reason: "file_missing",
        },
      ],
    });
    // Someone requests it again: a new request, a new time.
    await requestUpload(runId, [ids["a.nd2"]]);
    const res = await reportFailures({
      files: [
        {
          file_id: first.id,
          requested_at: first.upload_requested_at,
          reason: "file_missing",
        },
      ],
    });
    expect(await res.json()).toEqual({ failed: 0, skipped: 1 });
    expect((await fileRow(ids["a.nd2"])).status).toBe("upload_requested");
  });

  it("fails an auto-mode file named by run and path, keeping the error", async () => {
    const { runId, ids } = await reportRun(["a.nd2"], { willUpload: true });
    const res = await reportFailures({
      files: [
        {
          run_id: runId,
          relative_path: `${runId}/a.nd2`,
          reason: "upload_error",
          detail: "Connection reset by S3",
        },
      ],
    });
    expect(await res.json()).toEqual({ failed: 1, skipped: 0 });
    const row = await fileRow(ids["a.nd2"]);
    expect(row.status).toBe("upload_failed");
    expect(row.autoUploadExpectedAt).toBe(null);
    expect(row.errorMessage).toBe(
      "The watcher couldn't upload the file: Connection reset by S3"
    );
  });

  it("skips an auto-mode file the watcher never said it would upload", async () => {
    const { runId } = await reportRun(["a.nd2"]);
    const res = await reportFailures({
      files: [
        {
          run_id: runId,
          relative_path: `${runId}/a.nd2`,
          reason: "file_missing",
        },
      ],
    });
    expect(await res.json()).toEqual({ failed: 0, skipped: 1 });
  });

  it("skips files of another watcher's instrument", async () => {
    const { runId, ids } = await reportRun(["a.nd2"]);
    await requestUpload(runId, [ids["a.nd2"]]);
    const [item] = (await queue()).filter((f) => f.run_id === runId);
    const res = await reportFailures(
      {
        files: [
          {
            file_id: item.id,
            requested_at: item.upload_requested_at,
            reason: "file_missing",
          },
        ],
      },
      otherWatcherId
    );
    expect(await res.json()).toEqual({ failed: 0, skipped: 1 });
    expect((await fileRow(ids["a.nd2"])).status).toBe("upload_requested");
  });

  it("skips a file of a deleted run", async () => {
    const { runId, ids } = await reportRun(["a.nd2"], { willUpload: true });
    await getTestDb()
      .update(instrumentRuns)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          eq(instrumentRuns.runId, runId)
        )
      );
    const res = await reportFailures({
      files: [
        {
          run_id: runId,
          relative_path: `${runId}/a.nd2`,
          reason: "file_missing",
        },
      ],
    });
    expect(await res.json()).toEqual({ failed: 0, skipped: 1 });
    expect((await fileRow(ids["a.nd2"])).status).toBe("detected");
  });

  it("refuses an item that names no file", async () => {
    const res = await reportFailures({
      files: [{ reason: "file_missing" }],
    });
    expect(res.status).toBe(400);
  });
});

describe("after a failure", () => {
  async function failedFile() {
    const { runId, ids } = await reportRun(["a.nd2"]);
    await requestUpload(runId, [ids["a.nd2"]]);
    const [item] = (await queue()).filter((f) => f.run_id === runId);
    await reportFailures({
      files: [
        {
          file_id: item.id,
          requested_at: item.upload_requested_at,
          reason: "file_missing",
        },
      ],
    });
    return { runId, id: ids["a.nd2"] };
  }

  it("T2: a new request clears the reason", async () => {
    const { runId, id } = await failedFile();
    await requestUpload(runId, [id]);
    const row = await fileRow(id);
    expect(row.status).toBe("upload_requested");
    expect(row.uploadFailureReason).toBe(null);
    expect(row.uploadFailedAt).toBe(null);
    expect(row.errorMessage).toBe(null);
  });

  it("T2: request-all picks up upload_failed files", async () => {
    const { runId, id } = await failedFile();
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-all`,
      { method: "POST", token }
    );
    expect(res.status).toBe(200);
    expect((await fileRow(id)).status).toBe("upload_requested");
  });

  it("T6: an upload that lands clears the reason", async () => {
    const { id } = await failedFile();
    const res = await api(`/api/v1/files/${id}`, {
      method: "PATCH",
      token,
      body: { status: "uploaded" },
    });
    expect(res.status).toBe(200);
    const row = await fileRow(id);
    expect(row.status).toBe("uploaded");
    expect(row.uploadFailureReason).toBe(null);
    expect(row.errorMessage).toBe(null);
  });

  it("T7: the file can be dismissed", async () => {
    const { id } = await failedFile();
    const res = await api(`/api/v1/files/${id}`, { method: "DELETE", token });
    expect(res.status).toBe(200);
    expect((await fileRow(id)).deletedAt).not.toBe(null);
  });
});

describe("T3 and T4: clearing the mark", () => {
  it("T4: a manual-mode heartbeat clears the auto-upload mark", async () => {
    const { runId, ids } = await reportRun(["a.nd2"], { willUpload: true });
    await heartbeat(watcherId, "manual");
    expect((await fileRow(ids["a.nd2"])).autoUploadExpectedAt).toBe(null);
    expect(await runStatuses("not_uploaded")).toContain(runId);
  });

  it("T3: an old watcher's cancel clears the request and the requester", async () => {
    const { runId, ids } = await reportRun(["a.nd2"]);
    await requestUpload(runId, [ids["a.nd2"]]);
    const res = await api(`/api/v1/files/${ids["a.nd2"]}`, {
      method: "PATCH",
      token,
      body: { status: "detected" },
    });
    expect(res.status).toBe(200);
    const row = await fileRow(ids["a.nd2"]);
    expect(row.status).toBe("detected");
    expect(row.uploadRequestedAt).toBe(null);
    expect(row.uploadRequestedBy).toBe(null);
  });

  it("T3: a watch-folder change reverts requests and clears marks", async () => {
    const requested = await reportRun(["a.nd2"]);
    await requestUpload(requested.runId, [requested.ids["a.nd2"]]);
    const marked = await reportRun(["b.nd2"], { willUpload: true });
    await api(`/api/v1/watchers/${watcherId}/config`, {
      method: "PUT",
      token,
      body: {
        config_checksum: "sum-moved",
        config_yaml: configYaml(instrumentId, "auto").replace(
          "/data",
          "/data-moved"
        ),
      },
    });
    const a = await fileRow(requested.ids["a.nd2"]);
    expect(a.status).toBe("detected");
    expect(a.uploadRequestedBy).toBe(null);
    expect((await fileRow(marked.ids["b.nd2"])).autoUploadExpectedAt).toBe(
      null
    );
  });
});

describe("after a failure is recorded", () => {
  async function requesterNotifications(runId: string) {
    const [run] = await getTestDb()
      .select({ id: instrumentRuns.id })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          eq(instrumentRuns.runId, runId)
        )
      );
    return getTestDb()
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.runId, run.id),
          eq(notifications.type, "upload_failed")
        )
      );
  }

  // The route notifies after it responds, so wait for the row.
  async function waitForNotification(runId: string) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await requesterNotifications(runId)).length > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for the upload_failed notification");
  }

  it("notifies the requester once per run and reason, and nobody for an auto-mode file", async () => {
    const requested = await reportRun(["a.nd2", "b.nd2"]);
    await requestUpload(requested.runId, Object.values(requested.ids));
    const auto = await reportRun(["c.nd2"], { willUpload: true });
    const body = {
      files: [
        ...(await queue())
          .filter((f) => f.run_id === requested.runId)
          .map((f) => ({
            file_id: f.id,
            requested_at: f.upload_requested_at,
            reason: "folder_missing",
          })),
        {
          run_id: auto.runId,
          relative_path: `${auto.runId}/c.nd2`,
          reason: "upload_error",
        },
      ],
    };
    expect(await (await reportFailures(body)).json()).toEqual({
      failed: 3,
      skipped: 0,
    });

    await waitForNotification(requested.runId);
    const rows = await requesterNotifications(requested.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe(
      "2 files couldn't upload: folder no longer on the instrument PC."
    );
    // Both groups are notified in one insert, so the auto-mode run's row
    // would be here by now.
    expect(await requesterNotifications(auto.runId)).toHaveLength(0);

    // A retried report moves nothing, so it notifies nobody.
    expect(await (await reportFailures(body)).json()).toEqual({
      failed: 0,
      skipped: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await requesterNotifications(requested.runId)).toHaveLength(1);
  });

  it("counts the run among its instrument's runs needing attention", async () => {
    const attention = async () =>
      (await getInstrumentSummaries()).find((row) => row.id === instrumentId)
        ?.runsNeedingAttention;
    const before = await attention();

    const { runId, ids } = await reportRun(["a.nd2"]);
    await requestUpload(runId, [ids["a.nd2"]]);
    const [item] = (await queue()).filter((f) => f.run_id === runId);
    await reportFailures({
      files: [
        {
          file_id: item.id,
          requested_at: item.upload_requested_at,
          reason: "file_missing",
        },
      ],
    });

    expect(await attention()).toEqual({
      failed: before?.failed,
      stalled: before?.stalled,
      uploadFailed: (before?.uploadFailed ?? 0) + 1,
      total: (before?.total ?? 0) + 1,
    });
  });
});

describe("database checks", () => {
  it("rejects an upload_failed file without a reason", async () => {
    const { ids } = await reportRun(["a.nd2"]);
    await expect(
      getTestDb()
        .update(files)
        .set({ status: "upload_failed" })
        .where(inArray(files.id, [ids["a.nd2"]]))
    ).rejects.toThrow();
  });

  it("rejects an auto-upload mark on an uploaded file", async () => {
    const { ids } = await reportRun(["a.nd2"]);
    await expect(
      getTestDb()
        .update(files)
        .set({ status: "uploaded", autoUploadExpectedAt: new Date() })
        .where(eq(files.id, ids["a.nd2"]))
    ).rejects.toThrow();
  });

  it("rejects a requester without a request", async () => {
    const { ids } = await reportRun(["a.nd2"]);
    await expect(
      getTestDb()
        .update(files)
        .set({ uploadRequestedBy: userId })
        .where(eq(files.id, ids["a.nd2"]))
    ).rejects.toThrow();
  });
});
