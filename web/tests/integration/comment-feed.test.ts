import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCommentFeed } from "@/lib/api/run-comments";
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
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Feed Instrument",
      status: "active",
    });

    const [liveRun, deletedRun] = await db
      .insert(instrumentRuns)
      .values([
        { instrumentId, runId: "feed-live", source: "lambda" },
        {
          instrumentId,
          runId: "feed-deleted-run",
          source: "lambda",
          deletedAt: new Date("2026-01-01T00:00:00.000Z"),
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
    ]);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("drops deleted comments and comments on deleted runs, newest first", async () => {
    const page = await listCommentFeed({ perPage: 10 });
    expect(page.data.map((row) => row.body)).toEqual([
      "newest live",
      "oldest live",
    ]);
    expect(page.pagination.total).toBe(2);
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
    expect(page.data.map((row) => row.body)).toEqual(["oldest live"]);
    expect(page.pagination).toMatchObject({
      page: 2,
      per_page: 1,
      total: 2,
      total_pages: 2,
    });
  });
});
