import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updatePreferences } from "@/lib/api/notifications";
import { WATCHER_VERSION_HEADER } from "@/lib/api/watcher-compat";
import {
  files,
  instrumentRuns,
  instruments,
  runAttributions,
  slackConnections,
  watchers,
} from "@/lib/db/schema";
import {
  api,
  clearCapturedSlackDms,
  closeTestDb,
  getCapturedSlackDms,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Creating a run trims its run ID, so ` RUN1 ` is stored as `RUN1`. A watcher
// whose run ID has a space at either end (a folder named ` RUN1`, or a file
// pattern that captures `RUN1 ` from `RUN1 _a.csv`) keeps sending the ID with
// the space. Every later request has to find the run with or without it.

const SPELLINGS: [label: string, runId: string][] = [
  ["with spaces", " RUN1 "],
  ["without spaces", "RUN1"],
];

describe("Run IDs with spaces at the start or end", () => {
  let token: string;
  const instrumentId = "padded-run-instrument";
  const storedRunId = "RUN1";
  const watcher12 = { [WATCHER_VERSION_HEADER]: "1.2.0" };

  function runPath(runId: string, suffix = ""): string {
    return `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}${suffix}`;
  }

  async function storedRunUuid(runId = storedRunId): Promise<string> {
    const [row] = await getTestDb()
      .select({ id: instrumentRuns.id })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          eq(instrumentRuns.runId, runId)
        )
      );
    return row.id;
  }

  // Adds a file to the run by its stored ID and returns the file's ID.
  async function addDetectedFile(filename: string): Promise<number> {
    const patched = await api(runPath(storedRunId), {
      method: "PATCH",
      token,
      body: {
        detected_files: [
          { relative_path: filename, filename, size_bytes: 128 },
        ],
      },
    });
    expect(patched.status).toBe(200);
    const detail = await (await api(runPath(storedRunId), { token })).json();
    const file = detail.files.find(
      (f: { filename: string }) => f.filename === filename
    );
    return file.id;
  }

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Padded Run Instrument",
      status: "active",
    });
    // Asking for an upload needs an online watcher.
    await db.insert(watchers).values({
      instrumentId,
      hostname: "online-pc",
      status: "watching",
      lastHeartbeatAt: new Date(),
    });

    const created = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: " RUN1 ",
        source: "watcher",
        detected_files: [
          { relative_path: "a.csv", filename: "a.csv", size_bytes: 128 },
        ],
      },
    });
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("stores the ID without the spaces", async () => {
    const rows = await getTestDb()
      .select({ runId: instrumentRuns.runId })
      .from(instrumentRuns)
      .where(eq(instrumentRuns.instrumentId, instrumentId));
    expect(rows).toEqual([{ runId: storedRunId }]);
  });

  it.each(SPELLINGS)("GET finds the run %s", async (_label, runId) => {
    const res = await api(runPath(runId), { token });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.run_id).toBe(storedRunId);
    expect(data.files.map((f: { filename: string }) => f.filename)).toContain(
      "a.csv"
    );
  });

  it.each(
    SPELLINGS
  )("PATCH adds detected files to the run %s", async (label, runId) => {
    const filename = `patched-${label.replace(" ", "-")}.csv`;
    const res = await api(runPath(runId), {
      method: "PATCH",
      token,
      body: {
        detected_files: [{ relative_path: filename, filename, size_bytes: 64 }],
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).run_id).toBe(storedRunId);

    const detail = await (await api(runPath(storedRunId), { token })).json();
    expect(detail.files.map((f: { filename: string }) => f.filename)).toContain(
      filename
    );
  });

  it.each(
    SPELLINGS
  )("request-upload-url builds the S3 key from the stored run ID %s", async (label, runId) => {
    const filename = `upload-${label.replace(" ", "-")}.csv`;
    const res = await api(runPath(runId, "/request-upload-url"), {
      method: "POST",
      token,
      body: { filename, content_type: "text/csv" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const expectedKey = `${instrumentId}/${storedRunId}/${filename}`;
    expect(data.s3_key).toBe(expectedKey);
    expect(data.upload_url).toBe(
      `/api/local-s3/${data.s3_bucket}/${expectedKey}`
    );

    const [row] = await getTestDb()
      .select({ instrumentRunId: files.instrumentRunId })
      .from(files)
      .where(eq(files.id, data.file_id));
    expect(row.instrumentRunId).toBe(await storedRunUuid());
  });

  it.each(
    SPELLINGS
  )("request-upload-url starts a multipart upload under the stored run ID %s", async (label, runId) => {
    const filename = `parts-${label.replace(" ", "-")}.bin`;
    const res = await api(runPath(runId, "/request-upload-url"), {
      method: "POST",
      token,
      headers: watcher12,
      body: {
        filename,
        content_type: "application/octet-stream",
        size_bytes: 1500,
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upload_type).toBe("multipart");
    expect(data.s3_key).toBe(`${instrumentId}/${storedRunId}/${filename}`);

    // The part URLs come from the file's own run, not from a run ID.
    const parts = await api(
      `/api/v1/files/${data.file_id}/multipart-upload/part-urls`,
      {
        method: "POST",
        token,
        body: { upload_id: data.upload_id, part_numbers: [1] },
      }
    );
    expect(parts.status).toBe(200);
    const [first] = (await parts.json()).parts;
    expect(first.upload_url).toContain(
      `${instrumentId}/${storedRunId}/${filename}`
    );
  });

  it.each(
    SPELLINGS
  )("request-upload queues a file of the run %s", async (label, runId) => {
    const fileId = await addDetectedFile(
      `queued-${label.replace(" ", "-")}.csv`
    );
    const res = await api(runPath(runId, "/request-upload"), {
      method: "POST",
      token,
      body: { file_ids: [fileId] },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.run_id).toBe(storedRunId);
    expect(data.files_queued).toBe(1);

    const [row] = await getTestDb()
      .select({ status: files.status })
      .from(files)
      .where(eq(files.id, fileId));
    expect(row.status).toBe("upload_requested");
  });

  it.each(
    SPELLINGS
  )("request-upload-all queues the files of the run %s", async (label, runId) => {
    const fileId = await addDetectedFile(`all-${label.replace(" ", "-")}.csv`);
    const res = await api(runPath(runId, "/request-upload-all"), {
      method: "POST",
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.run_id).toBe(storedRunId);
    expect(data.files_queued).toBeGreaterThanOrEqual(1);

    const [row] = await getTestDb()
      .select({ status: files.status })
      .from(files)
      .where(eq(files.id, fileId));
    expect(row.status).toBe("upload_requested");
  });

  it.each(
    SPELLINGS
  )("DELETE and restore find the run %s", async (_label, runId) => {
    const deleted = await api(runPath(runId), { method: "DELETE", token });
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json();
    expect(deletedBody.run_id).toBe(storedRunId);
    expect(deletedBody.already_applied).toBe(false);

    const restored = await api(runPath(runId, "/restore"), {
      method: "POST",
      token,
    });
    expect(restored.status).toBe(200);
    const restoredBody = await restored.json();
    expect(restoredBody.run_id).toBe(storedRunId);
    expect(restoredBody.already_applied).toBe(false);
    expect(restoredBody.deleted_at).toBeNull();
  });

  it("sends comment notifications with the stored run ID", async () => {
    const { userId: recipientId } = await seedTestUser();
    const db = getTestDb();
    await db
      .insert(runAttributions)
      .values({ runId: await storedRunUuid(), userId: recipientId });
    await db.insert(slackConnections).values({
      userId: recipientId,
      slackUserId: "U_PADDED_RUN",
      slackTeamId: "T_TEST",
      slackTeamName: "Test Workspace",
      connectedAt: new Date(),
      revokedAt: null,
    });
    await updatePreferences(recipientId, {
      slackCommentsAttributedEnabled: true,
    });
    await clearCapturedSlackDms();

    const res = await api(runPath(" RUN1 ", "/comments"), {
      method: "POST",
      token,
      body: { body: "Looks good." },
    });
    expect(res.status).toBe(201);

    const deadline = Date.now() + 3000;
    let dms = await getCapturedSlackDms();
    while (dms.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      dms = await getCapturedSlackDms();
    }
    expect(dms).toHaveLength(1);
    const text = JSON.stringify(dms[0].blocks);
    expect(text).toContain(`/instruments/${instrumentId}/runs/${storedRunId}#`);
    expect(text).toContain("`RUN1`");
    expect(text).not.toContain("%20");
  });

  it("keeps spaces inside the ID", async () => {
    const created = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: "  run 2 ", source: "lambda" },
    });
    expect(created.status).toBe(201);
    expect((await created.json()).run_id).toBe("run 2");

    for (const runId of ["run 2", " run 2 "]) {
      const res = await api(runPath(runId), { token });
      expect(res.status).toBe(200);
      expect((await res.json()).run_id).toBe("run 2");
    }
  });

  it("still tells runs apart by anything but outer spaces", async () => {
    for (const runId of [" run1 ", "RUN 1", "RUN1 _a", "RUN2"]) {
      const res = await api(runPath(runId), { token });
      expect(res.status).toBe(404);
    }
  });

  it.each([
    ["GET", ""],
    ["PATCH", ""],
    ["DELETE", ""],
    ["POST", "/restore"],
    ["POST", "/request-upload-url"],
    ["POST", "/request-upload-all"],
    ["POST", "/comments"],
    ["GET", "/notebook-links"],
    ["POST", "/notebook-links"],
  ])("%s %s returns 404 for an ID that is only spaces", async (method, suffix) => {
    const res = await api(runPath("   ", suffix), {
      method,
      token,
      body: method === "GET" || method === "DELETE" ? undefined : {},
    });
    expect(res.status).toBe(404);
  });
});
