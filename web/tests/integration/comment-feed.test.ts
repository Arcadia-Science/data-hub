import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listCommentFeed,
  listCommentInstrumentFacets,
} from "@/lib/api/run-comments";
import {
  instrumentRuns,
  instruments,
  runAttributions,
  runComments,
} from "@/lib/db/schema";
import {
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

describe("listCommentFeed", () => {
  const instrumentId = "comment-feed-instrument";
  const otherInstrumentId = "comment-feed-instrument-b";
  const emptyInstrumentId = "comment-feed-instrument-empty";
  let authorId: string;
  let otherId: string;

  beforeAll(async () => {
    await resetDb();
    ({ userId: authorId } = await seedTestUser({
      email: "feed-author@example.com",
      name: "Feed Author",
    }));
    ({ userId: otherId } = await seedTestUser({
      email: "feed-other@example.com",
      name: "Feed Other",
    }));

    const db = getTestDb();
    await db.insert(instruments).values([
      {
        id: instrumentId,
        displayName: "Feed Instrument",
        status: "active",
      },
      {
        id: otherInstrumentId,
        displayName: "Other Instrument",
        status: "active",
      },
      {
        id: emptyInstrumentId,
        displayName: "Empty Instrument",
        status: "active",
      },
    ]);

    const [liveRun, deletedRun, otherRun] = await db
      .insert(instrumentRuns)
      .values([
        { instrumentId, runId: "feed-live", source: "lambda" },
        {
          instrumentId,
          runId: "feed-deleted-run",
          source: "lambda",
          deletedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          instrumentId: otherInstrumentId,
          runId: "feed-other",
          source: "lambda",
        },
      ])
      .returning({ id: instrumentRuns.id });

    await db.insert(runAttributions).values({
      runId: liveRun.id,
      userId: authorId,
    });

    await db.insert(runComments).values([
      {
        runId: liveRun.id,
        userId: authorId,
        body: "oldest live",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
      {
        runId: liveRun.id,
        userId: otherId,
        body: "newest live",
        createdAt: new Date("2026-09-03T00:00:00.000Z"),
      },
      {
        runId: liveRun.id,
        userId: authorId,
        body: "deleted comment",
        createdAt: new Date("2026-09-04T00:00:00.000Z"),
        deletedAt: new Date("2026-09-05T00:00:00.000Z"),
      },
      {
        runId: deletedRun.id,
        userId: otherId,
        body: "comment on deleted run",
        createdAt: new Date("2026-09-06T00:00:00.000Z"),
      },
      {
        runId: otherRun.id,
        userId: otherId,
        body: "other instrument",
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
      },
    ]);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("drops deleted comments and comments on deleted runs, newest first", async () => {
    const page = await listCommentFeed({ perPage: 10 });
    expect(page.data.map((row) => row.body)).toEqual([
      "newest live",
      "other instrument",
      "oldest live",
    ]);
    expect(page.pagination.total).toBe(3);
    expect(page.data[0]?.run.runId).toBe("feed-live");
    expect(page.data[0]?.run.instrumentDisplayName).toBe("Feed Instrument");
  });

  it("filters by author", async () => {
    const page = await listCommentFeed({ authorId });
    expect(page.data.map((row) => row.body)).toEqual(["oldest live"]);
  });

  it("includes the attributed user's own comments on their runs", async () => {
    const page = await listCommentFeed({ ranBy: authorId });
    expect(page.data.map((row) => row.body)).toEqual([
      "newest live",
      "oldest live",
    ]);
  });

  it("paginates with a stable total", async () => {
    const page = await listCommentFeed({ page: 2, perPage: 1 });
    expect(page.data.map((row) => row.body)).toEqual(["other instrument"]);
    expect(page.pagination).toMatchObject({
      page: 2,
      per_page: 1,
      total: 3,
      total_pages: 3,
    });
  });

  it("filters by comment created_at", async () => {
    const page = await listCommentFeed({
      dateFrom: "2026-09-03T00:00:00.000Z",
    });
    expect(page.data.map((row) => row.body)).toEqual(["newest live"]);
    expect(page.pagination.total).toBe(1);
  });

  it("filters by instrument", async () => {
    const page = await listCommentFeed({ instrumentIds: [otherInstrumentId] });
    expect(page.data.map((row) => row.body)).toEqual(["other instrument"]);
    expect(page.pagination.total).toBe(1);
  });

  it("counts live comments per instrument and keeps a selected empty one", async () => {
    const facets = await listCommentInstrumentFacets({
      includeIds: [emptyInstrumentId],
    });
    expect(facets).toEqual([
      { id: emptyInstrumentId, displayName: "Empty Instrument", count: 0 },
      { id: instrumentId, displayName: "Feed Instrument", count: 2 },
      { id: otherInstrumentId, displayName: "Other Instrument", count: 1 },
    ]);
  });
});
