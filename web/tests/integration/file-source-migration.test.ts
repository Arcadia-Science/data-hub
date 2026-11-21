import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  instrumentRuns,
  instruments,
  files as schemaFiles,
} from "@/lib/db/schema";
import {
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import {
  TEST_PROCESSED_BUCKET,
  TEST_RAW_BUCKET,
} from "@/tests/integration/test-buckets";

// Migration 0073 adds who deleted a file and which raw file a processed file
// came from, and 0074 links the processed files that already exist. The test
// database is built from the current schema, so the first part takes the new
// columns away and runs 0073 on the table. The second part fills a run with
// files in the shapes the processors write and runs 0074 on them.

const DRIZZLE = path.resolve(import.meta.dirname, "../../drizzle");

function statements(file: string): string[] {
  return readFileSync(path.join(DRIZZLE, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

// drizzle-kit applies a migration in one transaction, which the `SET LOCAL` in
// 0073 needs. A transaction does the same here.
async function runMigration(file: string) {
  await getTestDb().transaction(async (tx) => {
    for (const statement of statements(file)) {
      await tx.execute(sql.raw(statement));
    }
  });
}

const instrumentId = "source-migration-instrument";

describe("migration 0073_file_deleted_by_and_source", () => {
  let userId = "";
  let tokenId = "";
  let runUuid = "";

  beforeAll(async () => {
    await resetDb();
    const db = getTestDb();
    ({ userId, tokenId } = await seedTestUser());
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Source Migration Instrument",
      status: "active",
    });
    const [run] = await db
      .insert(instrumentRuns)
      .values({ instrumentId, runId: "schema-run", source: "lambda" })
      .returning({ id: instrumentRuns.id });
    runUuid = run.id;

    // Put the table back the way it was before the migration.
    await db.execute(
      sql.raw(
        'ALTER TABLE "files" DROP COLUMN "deleted_by", DROP COLUMN "deleted_by_token", DROP COLUMN "source_file_id"'
      )
    );
    await runMigration("0073_file_deleted_by_and_source.sql");
  });

  afterAll(async () => {
    await resetDb();
    await closeTestDb();
  });

  async function seed(
    filename: string,
    values: Partial<typeof schemaFiles.$inferInsert> = {}
  ) {
    const [row] = await getTestDb()
      .insert(schemaFiles)
      .values({
        instrumentRunId: runUuid,
        relativePath: filename,
        filename,
        status: "uploaded",
        ...values,
      })
      .returning();
    return row;
  }

  it("adds the three columns, empty on every existing row", async () => {
    const row = await seed("plain.csv");
    expect(row.deletedBy).toBeNull();
    expect(row.deletedByToken).toBeNull();
    expect(row.sourceFileId).toBeNull();
  });

  it("makes the actor columns and the source reference real keys", async () => {
    const stored = await seed("who.csv", { deletedAt: new Date() });
    await getTestDb()
      .update(schemaFiles)
      .set({ deletedBy: userId })
      .where(eq(schemaFiles.id, stored.id));
    const other = await seed("by-token.csv", { deletedAt: new Date() });
    await getTestDb()
      .update(schemaFiles)
      .set({ deletedByToken: tokenId })
      .where(eq(schemaFiles.id, other.id));

    await expect(
      getTestDb()
        .update(schemaFiles)
        .set({ deletedBy: "no-such-user" })
        .where(eq(schemaFiles.id, stored.id))
    ).rejects.toThrow();
    await expect(
      seed("bad-source.jpg", { sourceFileId: 999_999_999 })
    ).rejects.toThrow();
  });

  it("refuses a file deleted by a user and a token at once", async () => {
    const stored = await seed("both.csv", { deletedAt: new Date() });
    await expect(
      getTestDb()
        .update(schemaFiles)
        .set({ deletedBy: userId, deletedByToken: tokenId })
        .where(eq(schemaFiles.id, stored.id))
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "files_one_deleter" },
    });
  });

  it("adds the constraints without checking the existing rows", async () => {
    const result = await getTestDb().execute<{
      conname: string;
      convalidated: boolean;
    }>(sql`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conrelid = 'files'::regclass
        AND conname IN (
          'files_one_deleter',
          'files_source_file_id_files_id_fk',
          'files_deleted_by_user_id_fk',
          'files_deleted_by_token_personal_access_tokens_id_fk'
        )
      ORDER BY conname`);
    expect(result.rows.map((row) => row.conname)).toEqual([
      "files_deleted_by_token_personal_access_tokens_id_fk",
      "files_deleted_by_user_id_fk",
      "files_one_deleter",
      "files_source_file_id_files_id_fk",
    ]);
    // `NOT VALID`, so the deploy doesn't scan the table. A later migration
    // validates them.
    expect(result.rows.every((row) => row.convalidated === false)).toBe(true);
  });

  it("clears the source of a processed file whose raw row is removed", async () => {
    const raw = await seed("made-from.tif", {
      s3Bucket: TEST_RAW_BUCKET,
      s3Key: `${instrumentId}/schema-run/made-from.tif`,
    });
    const processed = await seed("made-from.jpg", {
      category: "processed",
      sourceFileId: raw.id,
    });
    await getTestDb().delete(schemaFiles).where(eq(schemaFiles.id, raw.id));
    const [after] = await getTestDb()
      .select({ sourceFileId: schemaFiles.sourceFileId })
      .from(schemaFiles)
      .where(eq(schemaFiles.id, processed.id));
    expect(after.sourceFileId).toBeNull();
  });

  it("indexes only the rows that have a source", async () => {
    const result = await getTestDb().execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'files' AND indexname = 'idx_files_source_file_id'`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.indexdef).toContain("source_file_id IS NOT NULL");
  });
});

describe("migration 0074_backfill_file_source_links", () => {
  const runName = "backfill-run";
  let runUuid = "";
  let otherRunUuid = "";

  beforeAll(async () => {
    await resetDb();
    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Source Migration Instrument",
      status: "active",
    });
    const runs = await db
      .insert(instrumentRuns)
      .values([
        { instrumentId, runId: runName, source: "lambda" },
        { instrumentId, runId: "backfill-other-run", source: "lambda" },
      ])
      .returning({ id: instrumentRuns.id, runId: instrumentRuns.runId });
    runUuid = runs.find((run) => run.runId === runName)?.id ?? "";
    otherRunUuid =
      runs.find((run) => run.runId === "backfill-other-run")?.id ?? "";
  });

  afterAll(async () => {
    await resetDb();
    await closeTestDb();
  });

  async function raw(
    filename: string,
    values: Partial<typeof schemaFiles.$inferInsert> = {}
  ) {
    const [row] = await getTestDb()
      .insert(schemaFiles)
      .values({
        instrumentRunId: runUuid,
        relativePath: filename,
        filename,
        status: "completed",
        s3Bucket: TEST_RAW_BUCKET,
        s3Key: `${instrumentId}/${runName}/${filename}`,
        ...values,
      })
      .returning();
    return row;
  }

  async function processed(
    filename: string,
    values: Partial<typeof schemaFiles.$inferInsert> = {}
  ) {
    const [row] = await getTestDb()
      .insert(schemaFiles)
      .values({
        instrumentRunId: runUuid,
        relativePath: filename,
        filename,
        category: "processed",
        status: "uploaded",
        s3Bucket: TEST_PROCESSED_BUCKET,
        s3Key: `${instrumentId}/${runName}/${filename}`,
        ...values,
      })
      .returning();
    return row;
  }

  async function sourceOf(id: number) {
    const [row] = await getTestDb()
      .select({ sourceFileId: schemaFiles.sourceFileId })
      .from(schemaFiles)
      .where(eq(schemaFiles.id, id));
    return row.sourceFileId;
  }

  it("links the video and the preview image to the raw file of the same name", async () => {
    const tiff = await raw("s001_A.tif");
    const copy = await raw("s001_A_1~0a1b2c3d.tif", {
      relativePath: "cap_b/s001_A_1~0a1b2c3d.tif",
    });
    const video = await processed("s001_A.mp4");
    const image = await processed("s001_A.jpg");
    const copyVideo = await processed("s001_A_1~0a1b2c3d.mp4");

    await runMigration("0074_backfill_file_source_links.sql");

    expect(await sourceOf(video.id)).toBe(tiff.id);
    expect(await sourceOf(image.id)).toBe(tiff.id);
    expect(await sourceOf(copyVideo.id)).toBe(copy.id);
  });

  it("links the Epson scanner's colony table through `_colonies`", async () => {
    const scan = await raw("plate_1.tif");
    const preview = await processed("plate_1.jpg");
    const colonies = await processed("plate_1_colonies.csv");

    await runMigration("0074_backfill_file_source_links.sql");

    expect(await sourceOf(preview.id)).toBe(scan.id);
    expect(await sourceOf(colonies.id)).toBe(scan.id);
  });

  it("leaves a raw file's own row and a sidecar without a source", async () => {
    const sidecar = await raw("run.json");
    const tiff = await raw("lonely.tif");

    await runMigration("0074_backfill_file_source_links.sql");

    expect(await sourceOf(sidecar.id)).toBeNull();
    expect(await sourceOf(tiff.id)).toBeNull();
  });

  it("does not link a processed file to a .json sidecar", async () => {
    await raw("manifest.json");
    const preview = await processed("manifest.jpg");

    await runMigration("0074_backfill_file_source_links.sql");

    expect(await sourceOf(preview.id)).toBeNull();
  });

  it("leaves a processed file that two raw files could have made", async () => {
    await raw("twin.tif");
    await raw("twin.nd2");
    const preview = await processed("twin.jpg");

    await runMigration("0074_backfill_file_source_links.sql");

    expect(await sourceOf(preview.id)).toBeNull();
  });

  it("leaves a processed file that no raw file matches", async () => {
    await raw("something.csv");
    const orphan = await processed("orphan.png");
    const wholeRun = await processed(`${runName}_raw_well_data.csv`);

    await runMigration("0074_backfill_file_source_links.sql");

    expect(await sourceOf(orphan.id)).toBeNull();
    expect(await sourceOf(wholeRun.id)).toBeNull();
  });

  it("matches only within a run", async () => {
    await raw("elsewhere.tif");
    const [preview] = await getTestDb()
      .insert(schemaFiles)
      .values({
        instrumentRunId: otherRunUuid,
        relativePath: "elsewhere.jpg",
        filename: "elsewhere.jpg",
        category: "processed",
        status: "uploaded",
        s3Bucket: TEST_PROCESSED_BUCKET,
        s3Key: `${instrumentId}/backfill-other-run/elsewhere.jpg`,
      })
      .returning();

    await runMigration("0074_backfill_file_source_links.sql");

    expect(await sourceOf(preview.id)).toBeNull();
  });

  it("ignores a raw file that never reached S3", async () => {
    await raw("waiting.tif", {
      status: "detected",
      s3Bucket: null,
      s3Key: null,
    });
    const preview = await processed("waiting.jpg");

    await runMigration("0074_backfill_file_source_links.sql");

    expect(await sourceOf(preview.id)).toBeNull();
  });

  it("links deleted files too, so a restore finds its links", async () => {
    const gone = await raw("gone.tif", { deletedAt: new Date() });
    const goneVideo = await processed("gone.mp4", { deletedAt: new Date() });

    await runMigration("0074_backfill_file_source_links.sql");

    expect(await sourceOf(goneVideo.id)).toBe(gone.id);
  });

  it("keeps a link that is already there and can run again", async () => {
    const chosen = await raw("chosen.tif");
    const other = await raw("other-source.tif");
    const preview = await processed("chosen.jpg", {
      sourceFileId: other.id,
    });
    const fresh = await processed("again.jpg");
    const tiff = await raw("again.tif");

    await runMigration("0074_backfill_file_source_links.sql");
    await runMigration("0074_backfill_file_source_links.sql");

    // The link the Lambda set is not replaced by the name match.
    expect(await sourceOf(preview.id)).toBe(other.id);
    expect(chosen.id).not.toBe(other.id);
    expect(await sourceOf(fresh.id)).toBe(tiff.id);
  });
});
