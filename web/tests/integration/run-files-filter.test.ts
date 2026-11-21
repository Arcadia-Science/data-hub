import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRunFilesQuery, getRunFileStats } from "@/lib/api/instrument-runs";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
import { closeTestDb, getTestDb, resetDb } from "@/tests/integration/helpers";

const instrumentId = "run-files-filter-instrument";

beforeAll(async () => {
  await resetDb();
  await getTestDb().insert(instruments).values({
    id: instrumentId,
    displayName: "Run Files Filter Instrument",
    status: "active",
  });
});

afterAll(async () => {
  await closeTestDb();
});

async function insertRun(runId: string) {
  const [run] = await getTestDb()
    .insert(instrumentRuns)
    .values({ instrumentId, runId, source: "watcher" })
    .returning({ id: instrumentRuns.id });
  return run.id;
}

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
    runInternalId = await insertRun("run-files-filter-run");

    await getTestDb()
      .insert(files)
      .values([
        {
          instrumentRunId: runInternalId,
          filename: "a-in-flight.csv",
          category: "raw",
          status: "processing",
          processingStartedAt: IN_FLIGHT_STARTED_AT,
        },
        {
          instrumentRunId: runInternalId,
          filename: "b-stalled.csv",
          category: "raw",
          status: "processing",
          processingStartedAt: STALLED_STARTED_AT,
        },
        // Predates the `processing_started_at` column.
        {
          instrumentRunId: runInternalId,
          filename: "c-stalled-null-start.csv",
          category: "raw",
          status: "processing",
          processingStartedAt: null,
        },
        {
          instrumentRunId: runInternalId,
          filename: "d-completed.csv",
          category: "raw",
          status: "completed",
        },
        {
          instrumentRunId: runInternalId,
          filename: "e-detected.csv",
          category: "raw",
          status: "detected",
        },
        {
          instrumentRunId: runInternalId,
          filename: "f-uploaded.csv",
          category: "raw",
          status: "uploaded",
        },
        {
          instrumentRunId: runInternalId,
          filename: "g-failed.csv",
          category: "raw",
          status: "failed",
        },
        // Waiting for a free processing slot after a reprocess request.
        {
          instrumentRunId: runInternalId,
          filename: "h-queued.csv",
          category: "raw",
          status: "queued",
          queuedAt: new Date(),
        },
      ]);
  });

  it("'processing' returns only files still inside the stall window", async () => {
    expect(await filenamesFor(["processing"])).toEqual(["a-in-flight.csv"]);
  });

  it("'queued' returns only queued files", async () => {
    expect(await filenamesFor(["queued"])).toEqual(["h-queued.csv"]);
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
  // Processing comes before Queued, Queued before Stalled, and Stalled before
  // Uploaded. A detected file nobody requested reads "Not uploaded", which
  // sorts right after Failed.
  it("sorts Queued between Processing and Stalled", async () => {
    const names = await filenamesFor(undefined, "status");
    expect(names.slice(0, 5)).toEqual([
      "d-completed.csv",
      "g-failed.csv",
      "e-detected.csv",
      "a-in-flight.csv",
      "h-queued.csv",
    ]);
    // The two stalled files share a rank, so they come back in file id order.
    expect(names.slice(5, 7)).toEqual([
      "b-stalled.csv",
      "c-stalled-null-start.csv",
    ]);
    expect(names.slice(7)).toEqual(["f-uploaded.csv"]);
  });

  it("counts in-flight and stalled files separately in the run stats", async () => {
    const stats = await getRunFileStats(runInternalId);
    expect(stats.processing).toBe(3);
    expect(stats.processingInFlight).toBe(1);
    expect(stats.stalled).toBe(2);
  });

  // The page keeps refreshing while files are queued, and the footer's
  // "uploaded" count and the Download all count include them (they are in S3).
  it("counts queued files in the run stats", async () => {
    const stats = await getRunFileStats(runInternalId);
    expect(stats.queued).toBe(1);
    // completed, failed, uploaded, and queued: everything in S3 not processing.
    expect(stats.uploaded).toBe(4);
  });
});

// Header sorts order by the chosen column and nothing else: raw and processed
// files are mixed in one list, and rows that tie come back in file id order.
describe("Run files sort", () => {
  let runInternalId: string;

  async function namesFor(
    sort: NonNullable<Parameters<typeof buildRunFilesQuery>[1]["sort"]>,
    order?: Parameters<typeof buildRunFilesQuery>[1]["order"]
  ) {
    const page = await buildRunFilesQuery(runInternalId, {
      page: 1,
      perPage: 100,
      sort,
      order,
    });
    return page.data.map((file) => file.filename);
  }

  beforeAll(async () => {
    runInternalId = await insertRun("run-files-sort-run");
    // The ids run b, a, d, c, so id order is not name order. The rows go in
    // highest id first, so a sort that left ties to the database would likely
    // list d-capture.tif before b-capture.tif. Sizes, creation times, and
    // statuses all order the files differently from their names.
    await getTestDb()
      .insert(files)
      .values([
        {
          id: 9_000_104,
          instrumentRunId: runInternalId,
          filename: "c-preview.mp4",
          category: "processed",
          status: "uploaded",
          sizeBytes: 200,
          fileCreatedAt: new Date("2026-11-04T10:00:00Z"),
        },
        {
          id: 9_000_103,
          instrumentRunId: runInternalId,
          filename: "d-capture.tif",
          category: "raw",
          status: "failed",
          sizeBytes: 300,
          fileCreatedAt: new Date("2026-11-01T10:00:00Z"),
        },
        {
          id: 9_000_102,
          instrumentRunId: runInternalId,
          filename: "a-preview.jpg",
          category: "processed",
          status: "uploaded",
          sizeBytes: 100,
          fileCreatedAt: new Date("2026-11-05T10:00:00Z"),
        },
        {
          id: 9_000_101,
          instrumentRunId: runInternalId,
          filename: "b-capture.tif",
          category: "raw",
          status: "completed",
          sizeBytes: 300,
          fileCreatedAt: new Date("2026-11-03T10:00:00Z"),
        },
      ]);
  });

  it("sorts by name without putting raw files first", async () => {
    expect(await namesFor("name")).toEqual([
      "a-preview.jpg",
      "b-capture.tif",
      "c-preview.mp4",
      "d-capture.tif",
    ]);
  });

  it("sorts by name, descending", async () => {
    expect(await namesFor("name", "desc")).toEqual([
      "d-capture.tif",
      "c-preview.mp4",
      "b-capture.tif",
      "a-preview.jpg",
    ]);
  });

  it("sorts by size in the direction asked, and ties by file id", async () => {
    // b and d are both 300 bytes. b has the lower id, so it is first both ways.
    expect(await namesFor("size", "asc")).toEqual([
      "a-preview.jpg",
      "c-preview.mp4",
      "b-capture.tif",
      "d-capture.tif",
    ]);
    expect(await namesFor("size", "desc")).toEqual([
      "b-capture.tif",
      "d-capture.tif",
      "c-preview.mp4",
      "a-preview.jpg",
    ]);
  });

  it("sorts by the created time, in the direction asked", async () => {
    expect(await namesFor("date", "asc")).toEqual([
      "d-capture.tif",
      "b-capture.tif",
      "c-preview.mp4",
      "a-preview.jpg",
    ]);
    expect(await namesFor("date", "desc")).toEqual([
      "a-preview.jpg",
      "c-preview.mp4",
      "b-capture.tif",
      "d-capture.tif",
    ]);
  });

  it("sorts by status label, in the direction asked, and ties by file id", async () => {
    // Completed, Failed, Uploaded. The two uploaded files share a rank.
    expect(await namesFor("status", "asc")).toEqual([
      "b-capture.tif",
      "d-capture.tif",
      "a-preview.jpg",
      "c-preview.mp4",
    ]);
    expect(await namesFor("status", "desc")).toEqual([
      "a-preview.jpg",
      "c-preview.mp4",
      "d-capture.tif",
      "b-capture.tif",
    ]);
  });

  it("sorts ascending when no order is given", async () => {
    expect(await namesFor("name")).toEqual(await namesFor("name", "asc"));
  });

  it("keeps the same order across page boundaries when rows tie", async () => {
    // Two files per page. A tie must not put a file on both pages, or neither.
    const seen: string[] = [];
    for (const page of [1, 2]) {
      const result = await buildRunFilesQuery(runInternalId, {
        page,
        perPage: 2,
        sort: "size",
        order: "desc",
      });
      seen.push(...result.data.map((file) => file.filename));
    }
    expect(seen).toEqual([
      "b-capture.tif",
      "d-capture.tif",
      "c-preview.mp4",
      "a-preview.jpg",
    ]);
  });
});

// Deleted files are counted for the "Show deleted files" filter and the footer
// whether or not they are listed, and a status filter never matches one.
describe("Run files deleted files", () => {
  let runInternalId: string;
  const deletedAt = new Date("2026-11-10T09:00:00Z");

  function query(
    filters: Partial<Parameters<typeof buildRunFilesQuery>[1]> = {}
  ) {
    return buildRunFilesQuery(runInternalId, {
      page: 1,
      perPage: 100,
      ...filters,
    });
  }

  beforeAll(async () => {
    runInternalId = await insertRun("run-files-deleted-run");
    await getTestDb()
      .insert(files)
      .values([
        {
          instrumentRunId: runInternalId,
          filename: "r1.tif",
          category: "raw",
          status: "completed",
          s3Bucket: "raw-bucket",
          s3Key: "deleted-run/r1.tif",
        },
        {
          instrumentRunId: runInternalId,
          filename: "r1.jpg",
          category: "processed",
          status: "uploaded",
          s3Bucket: "raw-bucket",
          s3Key: "deleted-run/r1.jpg",
        },
        // Completed before it was deleted.
        {
          instrumentRunId: runInternalId,
          filename: "r2.tif",
          category: "raw",
          status: "completed",
          s3Bucket: "raw-bucket",
          s3Key: "deleted-run/r2.tif",
          deletedAt,
        },
        {
          instrumentRunId: runInternalId,
          filename: "r2.jpg",
          category: "processed",
          status: "uploaded",
          s3Bucket: "raw-bucket",
          s3Key: "deleted-run/r2.jpg",
          deletedAt,
        },
        // Never left the instrument PC.
        {
          instrumentRunId: runInternalId,
          filename: "r3.tif",
          category: "raw",
          status: "detected",
          deletedAt,
        },
      ]);
  });

  it("lists active files only, and counts the deleted ones beside them", async () => {
    const page = await query();
    expect(page.data.map((file) => file.filename)).toEqual([
      "r1.jpg",
      "r1.tif",
    ]);
    expect(page.pagination.total).toBe(2);
    expect(page.deletedCount).toBe(3);
  });

  it("lists deleted files too when asked, and total counts them", async () => {
    const page = await query({ includeDeleted: true });
    expect(page.data.map((file) => file.filename)).toEqual([
      "r1.jpg",
      "r1.tif",
      "r2.jpg",
      "r2.tif",
      "r3.tif",
    ]);
    expect(page.pagination.total).toBe(5);
    expect(page.deletedCount).toBe(3);
  });

  it("pages through the total that includes deleted files", async () => {
    const page = await query({ includeDeleted: true, perPage: 2 });
    expect(page.pagination.total_pages).toBe(3);
  });

  it("counts the deleted files that match the search", async () => {
    const hidden = await query({ search: "r2" });
    expect(hidden.data).toEqual([]);
    expect(hidden.pagination.total).toBe(0);
    expect(hidden.deletedCount).toBe(2);

    const shown = await query({ search: "r2", includeDeleted: true });
    expect(shown.pagination.total).toBe(2);
    expect(shown.deletedCount).toBe(2);
  });

  it("counts the deleted files that match the type filter", async () => {
    const page = await query({ categories: ["raw"] });
    expect(page.pagination.total).toBe(1);
    expect(page.deletedCount).toBe(2);
  });

  it("never matches a deleted file with a status filter", async () => {
    // r2.tif was Completed before it was deleted. Deleted files read "Deleted".
    const hidden = await query({ statuses: ["completed"] });
    expect(hidden.data.map((file) => file.filename)).toEqual(["r1.tif"]);
    expect(hidden.pagination.total).toBe(1);
    expect(hidden.deletedCount).toBe(0);

    const shown = await query({
      statuses: ["completed"],
      includeDeleted: true,
    });
    expect(shown.data.map((file) => file.filename)).toEqual(["r1.tif"]);
    expect(shown.pagination.total).toBe(1);
    expect(shown.deletedCount).toBe(0);

    const notUploaded = await query({
      statuses: ["not_uploaded"],
      includeDeleted: true,
    });
    expect(notUploaded.data).toEqual([]);
  });

  it("does not count deleted files as downloadable", async () => {
    const hidden = await query();
    const shown = await query({ includeDeleted: true });
    // r2.tif and r2.jpg are in storage, but deleted.
    expect(hidden.downloadableCount).toBe(2);
    expect(shown.downloadableCount).toBe(2);
  });
});
