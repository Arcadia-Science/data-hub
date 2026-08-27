import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRunFilesQuery, getRunFileStats } from "@/lib/api/instrument-runs";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
import { closeTestDb, getTestDb, resetDb } from "@/tests/integration/helpers";

// The run-detail files table splits the single `processing` DB status into two
// UI states on the stall cutoff. These tests drive `buildRunFilesQuery` and
// `getRunFileStats` against the test DB directly, because the filter has no
// REST endpoint of its own — the run-detail server component calls it.
//
// Global setup points `@/lib/db` at the test database, so the app's query
// builders and `getTestDb()` see the same rows.

const IN_FLIGHT_STARTED_AT = new Date(Date.now() - 60 * 1000);
const STALLED_STARTED_AT = new Date(Date.now() - 21 * 60 * 1000);

describe("Run files status filter", () => {
  const instrumentId = "run-files-filter-instrument";
  const runId = "run-files-filter-run";
  let runInternalId: string;

  async function filenamesFor(
    statuses: Parameters<typeof buildRunFilesQuery>[1]["statuses"],
    sort: Parameters<typeof buildRunFilesQuery>[1]["sort"] = "name"
  ) {
    const page = await buildRunFilesQuery(runInternalId, {
      page: 1,
      perPage: 100,
      sort,
      statuses,
    });
    return page.data.map((file) => file.filename);
  }

  beforeAll(async () => {
    await resetDb();
    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Run Files Filter Instrument",
      status: "active",
    });
    const [run] = await db
      .insert(instrumentRuns)
      .values({ instrumentId, runId, source: "watcher" })
      .returning({ id: instrumentRuns.id });
    runInternalId = run.id;

    await db.insert(files).values([
      {
        instrumentRunId: run.id,
        filename: "a-in-flight.csv",
        category: "raw",
        status: "processing",
        processingStartedAt: IN_FLIGHT_STARTED_AT,
      },
      {
        instrumentRunId: run.id,
        filename: "b-stalled.csv",
        category: "raw",
        status: "processing",
        processingStartedAt: STALLED_STARTED_AT,
      },
      // Predates the `processing_started_at` column.
      {
        instrumentRunId: run.id,
        filename: "c-stalled-null-start.csv",
        category: "raw",
        status: "processing",
        processingStartedAt: null,
      },
      {
        instrumentRunId: run.id,
        filename: "d-completed.csv",
        category: "raw",
        status: "completed",
      },
      {
        instrumentRunId: run.id,
        filename: "e-detected.csv",
        category: "raw",
        status: "detected",
      },
      {
        instrumentRunId: run.id,
        filename: "f-uploaded.csv",
        category: "raw",
        status: "uploaded",
      },
      {
        instrumentRunId: run.id,
        filename: "g-failed.csv",
        category: "raw",
        status: "failed",
      },
    ]);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("'processing' returns only files still inside the stall window", async () => {
    expect(await filenamesFor(["processing"])).toEqual(["a-in-flight.csv"]);
  });

  it("'stalled' returns files past the window and those with no start time", async () => {
    expect(await filenamesFor(["stalled"])).toEqual([
      "b-stalled.csv",
      "c-stalled-null-start.csv",
    ]);
  });

  // The two options partition `processing` exactly: selecting both is the old
  // "everything in processing" behaviour, and neither double-counts a row.
  it("selecting both covers every processing file exactly once", async () => {
    expect(await filenamesFor(["processing", "stalled"])).toEqual([
      "a-in-flight.csv",
      "b-stalled.csv",
      "c-stalled-null-start.csv",
    ]);
  });

  it("stamps stalledProcessing to match the filter each row answered to", async () => {
    const page = await buildRunFilesQuery(runInternalId, {
      page: 1,
      perPage: 100,
      sort: "name",
      statuses: ["processing", "stalled"],
    });
    expect(
      page.data.map((file) => [file.filename, file.stalledProcessing])
    ).toEqual([
      ["a-in-flight.csv", false],
      ["b-stalled.csv", true],
      ["c-stalled-null-start.csv", true],
    ]);
  });

  // Sort-by-status ranks rows by the label the status column shows, so
  // Processing must come before Stalled and both after Pending.
  it("sorts Stalled directly after Processing", async () => {
    expect(await filenamesFor(undefined, "status")).toEqual([
      "d-completed.csv",
      "g-failed.csv",
      "e-detected.csv",
      "a-in-flight.csv",
      "b-stalled.csv",
      "c-stalled-null-start.csv",
      "f-uploaded.csv",
    ]);
  });

  it("counts in-flight and stalled files separately in the run stats", async () => {
    const stats = await getRunFileStats(runInternalId);
    expect(stats.processing).toBe(3);
    expect(stats.processingInFlight).toBe(1);
    expect(stats.stalled).toBe(2);
  });
});
