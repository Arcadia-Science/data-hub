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

// Regression coverage for the REST `request-upload` route: it must hand raw
// `file_ids` to the shared helper, which fails closed on any non-integer
// entry. The route previously filtered non-numbers out and queued the rest,
// so a mixed payload like `[1, "2", 3]` silently succeeded with `[1, 3]`.

describe("Request Upload — file_ids validation", () => {
  let token: string;
  const instrumentId = "upload-validation-inst";
  const runId = "run-1";
  let fileIds: number[];

  function uploadPath(): string {
    return `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload`;
  }

  async function fileStatuses(): Promise<string[]> {
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
      .select({ status: files.status })
      .from(files)
      .where(eq(files.instrumentRunId, run.id));
    return rows.map((r) => r.status);
  }

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Upload Validation Instrument",
      status: "active",
    });
    await db.insert(watchers).values({
      instrumentId,
      hostname: "online-pc",
      status: "watching",
      lastHeartbeatAt: new Date(),
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

    const db2 = getTestDb();
    const [run] = await db2
      .select({ id: instrumentRuns.id })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          eq(instrumentRuns.runId, runId)
        )
      );
    const rows = await db2
      .select({ id: files.id })
      .from(files)
      .where(eq(files.instrumentRunId, run.id));
    fileIds = rows.map((r) => r.id);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("rejects a mixed payload without queuing any file", async () => {
    const res = await api(uploadPath(), {
      method: "POST",
      token,
      body: { file_ids: [fileIds[0], "2", fileIds[1]] },
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");

    // Nothing should have transitioned — the whole batch is rejected.
    expect(await fileStatuses()).toEqual(["detected", "detected"]);
  });

  it("rejects an empty file_ids array", async () => {
    const res = await api(uploadPath(), {
      method: "POST",
      token,
      body: { file_ids: [] },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  it("queues every id when the payload is all integers", async () => {
    const res = await api(uploadPath(), {
      method: "POST",
      token,
      body: { file_ids: fileIds },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files_queued).toBe(fileIds.length);
    expect(await fileStatuses()).toEqual([
      "upload_requested",
      "upload_requested",
    ]);
  });
});
