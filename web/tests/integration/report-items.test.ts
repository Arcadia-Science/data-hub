import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reportItemsResponse } from "@/lib/api/openapi";
import { files, instrumentRuns, instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getBaseUrl,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Backs the report-data viewers' search and seek. The run below holds more
// images than one window, and more than the old 100-item carousel cap.
describe("Report Items API", () => {
  const instrumentId = "report-items-test-instrument";
  const runId = "report-items-test-run";
  const imageCount = 250;

  // A timelapse well has `{stem}.mp4` and its poster `{stem}.jpg`.
  const mediaRunId = "report-items-media-run";
  const otherRunId = "report-items-other-run";

  let token: string;
  let runInternalId: string;
  const mediaIds = new Map<string, number>();

  function path(query: string, run = runId): string {
    return `/api/v1/instruments/${instrumentId}/runs/${run}/report-items?${query}`;
  }

  function mediaFile(
    runInternal: string,
    run: string,
    filename: string,
    overrides: Partial<typeof files.$inferInsert> = {}
  ): typeof files.$inferInsert {
    const contentType = filename.endsWith(".mp4")
      ? "video/mp4"
      : filename.endsWith(".jpg")
        ? "image/jpeg"
        : null;
    return {
      instrumentRunId: runInternal,
      relativePath: filename,
      filename,
      contentType,
      status: "completed" as const,
      s3Bucket: "test-bucket",
      s3Key: `${instrumentId}/${run}/${filename}`,
      ...overrides,
    };
  }

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Report Items Test Instrument",
      status: "active",
      instrumentType: "hina_microscope",
    });
    const [run] = await db
      .insert(instrumentRuns)
      .values({ instrumentId, runId, source: "watcher" })
      .returning({ id: instrumentRuns.id });
    runInternalId = run.id;

    const imageRows = Array.from({ length: imageCount }, (_, i) => {
      const index = String(i).padStart(4, "0");
      const filename = `WellB01_Point${index}_ChannelFITC.png`;
      return {
        instrumentRunId: runInternalId,
        relativePath: filename,
        filename,
        contentType: "image/png",
        status: "completed" as const,
        s3Bucket: "test-bucket",
        s3Key: `${instrumentId}/${runId}/${filename}`,
      };
    });

    // Deliberately unpadded so the ordering assertion below fails under a
    // plain lexicographic sort (`Site_10` before `Site_2`).
    const spectrumRows = [1, 2, 10].map((n) => ({
      instrumentRunId: runInternalId,
      relativePath: `Site_${n}.csv`,
      filename: `Site_${n}.csv`,
      contentType: "text/csv",
      status: "completed" as const,
      s3Bucket: "test-bucket",
      s3Key: `${instrumentId}/${runId}/Site_${n}.csv`,
    }));

    const videoRows = ["empty", "gk134_high", "ruler"].map((stem) => ({
      instrumentRunId: runInternalId,
      relativePath: `${stem}.mp4`,
      filename: `${stem}.mp4`,
      contentType: "video/mp4",
      status: "completed" as const,
      s3Bucket: "test-bucket",
      s3Key: `${instrumentId}/${runId}/${stem}.mp4`,
    }));

    await db.insert(files).values([
      ...imageRows,
      ...spectrumRows,
      ...videoRows,
      {
        instrumentRunId: runInternalId,
        relativePath: "peaks.csv",
        filename: "peaks.csv",
        contentType: "text/csv",
        status: "completed" as const,
        s3Bucket: "test-bucket",
        s3Key: `${instrumentId}/${runId}/peaks.csv`,
      },
      {
        instrumentRunId: runInternalId,
        relativePath: "not-uploaded.png",
        filename: "not-uploaded.png",
        contentType: "image/png",
        status: "detected" as const,
      },
    ]);

    const [mediaRun, otherRun] = await db
      .insert(instrumentRuns)
      .values([
        { instrumentId, runId: mediaRunId, source: "watcher" },
        { instrumentId, runId: otherRunId, source: "watcher" },
      ])
      .returning({ id: instrumentRuns.id });
    const media = (filename: string, overrides = {}) =>
      mediaFile(mediaRun.id, mediaRunId, filename, overrides);
    const inserted = await db
      .insert(files)
      .values([
        media("well_A1.nd2"),
        media("well_A1.jpg"),
        media("well_A1.mp4"),
        // A still with no video stays an item.
        media("well_A2.jpg"),
        // A video with no still plays without a poster.
        media("well_A3.mp4"),
        // A deleted or not yet uploaded video does not hide its still.
        media("well_A4.jpg"),
        media("well_A4.mp4", { deletedAt: new Date() }),
        media("well_A5.jpg"),
        media("well_A5.mp4", {
          s3Bucket: null,
          s3Key: null,
          status: "detected",
        }),
        // A deleted still is not a poster.
        media("well_A6.jpg", { deletedAt: new Date() }),
        media("well_A6.mp4"),
        media("well_A10.jpg"),
        media("well_A10.mp4"),
        // A video in another run does not hide this run's still.
        mediaFile(otherRun.id, otherRunId, "well_A2.mp4"),
      ])
      .returning({
        id: files.id,
        filename: files.filename,
        run: files.instrumentRunId,
      });
    for (const row of inserted) {
      if (row.run === mediaRun.id && !mediaIds.has(row.filename)) {
        mediaIds.set(row.filename, row.id);
      }
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("returns 401 without a token", async () => {
    const res = await fetch(`${getBaseUrl()}${path("kind=image")}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a token without files:read", async () => {
    const { token: limited } = await seedTestUser({ scopes: ["runs:read"] });
    const res = await api(path("kind=image"), { token: limited });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown run", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/nope/report-items?kind=image`,
      { token }
    );
    expect(res.status).toBe(404);
  });

  it("rejects an unknown kind", async () => {
    const res = await api(path("kind=hologram"), { token });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns the first window with the full total and matches the schema", async () => {
    const res = await api(path("kind=image"), { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(reportItemsResponse.safeParse(body).success).toBe(true);
    expect(body.pagination).toMatchObject({ offset: 0, limit: 50 });
    expect(body.pagination.total).toBe(imageCount);
    expect(body.data).toHaveLength(50);
    expect(body.data[0].filename).toBe("WellB01_Point0000_ChannelFITC.png");
  });

  it("pages past the old 100-item carousel cap", async () => {
    const res = await api(path("kind=image&offset=200&limit=50"), { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pagination.total).toBe(imageCount);
    expect(body.data).toHaveLength(50);
    expect(body.data[0].filename).toBe("WellB01_Point0200_ChannelFITC.png");
    expect(body.data.at(-1).filename).toBe("WellB01_Point0249_ChannelFITC.png");
  });

  it("filters by filename substring across the whole run", async () => {
    const res = await api(path("kind=image&search=Point024"), { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pagination.total).toBe(10);
    expect(
      body.data.every((item: { filename: string }) =>
        item.filename.includes("Point024")
      )
    ).toBe(true);
  });

  it("treats LIKE wildcards in the search as literal text", async () => {
    const res = await api(path("kind=image&search=%25"), { token });
    expect(res.status).toBe(200);
    expect((await res.json()).pagination.total).toBe(0);
  });

  it("scopes results to the requested kind", async () => {
    const res = await api(path("kind=spectrum"), { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pagination.total).toBe(4);
    expect(
      body.data.every((item: { filename: string }) =>
        item.filename.endsWith(".csv")
      )
    ).toBe(true);
  });

  it("lists videos without mixing in other kinds", async () => {
    const res = await api(path("kind=video"), { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pagination.total).toBe(3);
    expect(
      body.data.map((item: { filename: string }) => item.filename)
    ).toEqual(["empty.mp4", "gk134_high.mp4", "ruler.mp4"]);
  });

  it("orders unpadded numeric filenames naturally", async () => {
    const res = await api(path("kind=spectrum&search=Site_"), { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(
      body.data.map((item: { filename: string }) => item.filename)
    ).toEqual(["Site_1.csv", "Site_2.csv", "Site_10.csv"]);
  });

  it("centres the window on an anchor and reports its index", async () => {
    const anchorName = "WellB01_Point0137_ChannelFITC.png";
    const [anchor] = await api(path(`kind=image&search=${anchorName}`), {
      token,
    }).then((res) =>
      res.json().then((body: { data: { id: number }[] }) => body.data)
    );

    const res = await api(path(`kind=image&anchor=${anchor.id}`), { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pagination.anchor_index).toBe(137);
    expect(body.pagination.offset).toBe(100);
    expect(body.data[37].filename).toBe(anchorName);
  });

  it("reports a null anchor index when the anchor is not in the kind", async () => {
    const [csv] = await api(path("kind=spectrum&search=peaks"), { token }).then(
      (res) => res.json().then((body: { data: { id: number }[] }) => body.data)
    );

    const res = await api(path(`kind=image&anchor=${csv.id}`), { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pagination.anchor_index).toBeNull();
    expect(body.pagination.offset).toBe(0);
  });

  it("excludes files that have no bytes in S3", async () => {
    const res = await api(path("kind=image&search=not-uploaded"), { token });
    expect(res.status).toBe(200);
    expect((await res.json()).pagination.total).toBe(0);
  });

  describe("media", () => {
    it("lists one item per source file, with each video's poster", async () => {
      const res = await api(path("kind=media", mediaRunId), { token });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(reportItemsResponse.safeParse(body).success).toBe(true);
      expect(body.pagination.total).toBe(7);
      expect(body.data).toEqual([
        {
          id: mediaIds.get("well_A1.mp4"),
          filename: "well_A1.mp4",
          poster_id: mediaIds.get("well_A1.jpg"),
        },
        {
          id: mediaIds.get("well_A2.jpg"),
          filename: "well_A2.jpg",
          poster_id: null,
        },
        {
          id: mediaIds.get("well_A3.mp4"),
          filename: "well_A3.mp4",
          poster_id: null,
        },
        {
          id: mediaIds.get("well_A4.jpg"),
          filename: "well_A4.jpg",
          poster_id: null,
        },
        {
          id: mediaIds.get("well_A5.jpg"),
          filename: "well_A5.jpg",
          poster_id: null,
        },
        {
          id: mediaIds.get("well_A6.mp4"),
          filename: "well_A6.mp4",
          poster_id: null,
        },
        {
          id: mediaIds.get("well_A10.mp4"),
          filename: "well_A10.mp4",
          poster_id: mediaIds.get("well_A10.jpg"),
        },
      ]);
    });

    it("leaves the poster field off the other kinds", async () => {
      const res = await api(path("kind=image", mediaRunId), { token });
      const body = await res.json();

      expect(body.pagination.total).toBe(5);
      expect(body.data.every((item: object) => !("poster_id" in item))).toBe(
        true
      );
    });

    it("starts at the first item when the anchor is a poster", async () => {
      const anchor = mediaIds.get("well_A10.jpg");
      const res = await api(path(`kind=media&anchor=${anchor}`, mediaRunId), {
        token,
      });
      const body = await res.json();

      expect(body.pagination.anchor_index).toBeNull();
      expect(body.pagination.offset).toBe(0);
    });
  });
});
