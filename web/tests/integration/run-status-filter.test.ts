import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Run status is derived (never stored) from a run's raw-file states. These
// tests seed files directly and assert the `?status=` filter and its
// `pagination.total` honor the same priority-exclusive ordering as
// `deriveRunStatus`. Every request is scoped by instrument_id so totals stay
// deterministic regardless of other seeded data.

type FileStatus =
  | "detected"
  | "upload_requested"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed";

// Files enter `processing` with a start timestamp. Backdating one past the
// stall window is what turns a run from "processing" into "stalled".
const INSIDE_STALL_WINDOW = new Date(Date.now() - 60 * 1000);
const PAST_STALL_WINDOW = new Date(Date.now() - 21 * 60 * 1000);

describe("Run status filter", () => {
  let token: string;
  const instrumentId = "run-status-filter-instrument";

  async function seedRun(
    runId: string,
    fileStatuses: FileStatus[],
    processingStartedAt: Date | null = INSIDE_STALL_WINDOW
  ) {
    const db = getTestDb();
    const [run] = await db
      .insert(instrumentRuns)
      .values({ instrumentId, runId, source: "watcher" })
      .returning({ id: instrumentRuns.id });
    if (fileStatuses.length > 0) {
      await db.insert(files).values(
        fileStatuses.map((status, i) => ({
          instrumentRunId: run.id,
          filename: `${runId}-${i}.csv`,
          category: "raw" as const,
          status,
          processingStartedAt:
            status === "processing" ? processingStartedAt : null,
        }))
      );
    }
  }

  async function fetchRuns(query: string) {
    const res = await api(
      `/api/v1/instrument-runs?instrument_id=${instrumentId}&per_page=100&${query}`,
      { token }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    return {
      ids: body.data.map((r: { run_id: string }) => r.run_id) as string[],
      total: body.pagination.total as number,
    };
  }

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Run Status Filter Instrument",
      status: "active",
    });

    // One run per terminal bucket. The mixed runs each pair a higher-priority
    // file with a completed file, proving priority-exclusivity: they must be
    // hidden from the lower-priority `completed` filter.
    await seedRun("rs-empty", []);
    await seedRun("rs-completed", ["completed", "completed"]);
    await seedRun("rs-failed", ["failed", "completed"]);
    await seedRun("rs-pending", ["detected", "completed"]);
    await seedRun("rs-uploaded", ["uploaded", "completed"]);
    await seedRun("rs-processing", ["processing", "completed"]);
    // Same file states as rs-processing, only the start timestamp differs.
    await seedRun("rs-stalled", ["processing", "completed"], PAST_STALL_WINDOW);
    // Predates the `processing_started_at` column, so it is stalled too.
    await seedRun("rs-stalled-null-start", ["processing"], null);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("filters to a single status and reports a matching total", async () => {
    const { ids, total } = await fetchRuns("status=failed");
    expect(ids).toEqual(["rs-failed"]);
    expect(total).toBe(1);
  });

  // The core parity guarantee: `completed` must exclude runs that merely
  // contain a completed file but rank higher (failed/pending/uploaded/processing).
  it("'completed' matches only all-completed runs", async () => {
    const { ids, total } = await fetchRuns("status=completed");
    expect(ids).toEqual(["rs-completed"]);
    expect(total).toBe(1);
  });

  it("'empty' matches only runs with no files", async () => {
    const { ids, total } = await fetchRuns("status=empty");
    expect(ids).toEqual(["rs-empty"]);
    expect(total).toBe(1);
  });

  // The whole point of the run-level bucket: a run whose processing died is
  // findable, and does not keep spinning under "processing" forever.
  it("'stalled' matches runs past the stall window, including null start times", async () => {
    const { ids, total } = await fetchRuns("status=stalled");
    expect(new Set(ids)).toEqual(
      new Set(["rs-stalled", "rs-stalled-null-start"])
    );
    expect(total).toBe(2);
  });

  it("'processing' matches only in-flight runs, not stalled ones", async () => {
    const { ids, total } = await fetchRuns("status=processing");
    expect(ids).toEqual(["rs-processing"]);
    expect(total).toBe(1);
  });

  it("OR's repeated status params together", async () => {
    const { ids, total } = await fetchRuns("status=failed&status=empty");
    expect(new Set(ids)).toEqual(new Set(["rs-failed", "rs-empty"]));
    expect(total).toBe(2);
  });

  it("accepts the comma-separated form", async () => {
    const { ids, total } = await fetchRuns("status=failed,empty");
    expect(new Set(ids)).toEqual(new Set(["rs-failed", "rs-empty"]));
    expect(total).toBe(2);
  });

  it("ignores unknown status values instead of erroring or over-filtering", async () => {
    const { total } = await fetchRuns("status=bogus");
    expect(total).toBe(8);
  });

  // Every seeded run must land in exactly one bucket, or the priority chain
  // has a gap and some run is unreachable from the filter.
  it("partitions every run across the status buckets", async () => {
    const buckets = await Promise.all(
      RUN_STATUS_VALUES.map((status) => fetchRuns(`status=${status}`))
    );
    const matched = buckets.flatMap((bucket) => bucket.ids);
    expect(matched).toHaveLength(new Set(matched).size);
    const { total } = await fetchRuns("");
    expect(matched).toHaveLength(total);
  });

  it("applies the same filter on the instrument-scoped endpoint", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs?status=pending&per_page=100`,
      { token }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((r: { run_id: string }) => r.run_id);
    expect(ids).toEqual(["rs-pending"]);
    expect(body.pagination.total).toBe(1);
  });
});
