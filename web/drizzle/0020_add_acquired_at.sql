ALTER TABLE "instrument_runs" ADD COLUMN "acquired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_instrument_runs_active_acquired_at" ON "instrument_runs" USING btree ("instrument_id",coalesce("acquired_at", "created_at") desc) WHERE "instrument_runs"."deleted_at" is null;--> statement-breakpoint
-- One-time backfill from the per-file manifest. The watcher already
-- captures st_birthtime / st_mtime in files.file_created_at, so existing
-- runs can be assigned an acquired_at retroactively. Lambda-created runs
-- and manual file uploads with no file_created_at remain NULL and the
-- list query falls back to created_at via coalesce.
UPDATE "instrument_runs" ir
SET "acquired_at" = sub.min_created
FROM (
  SELECT "instrument_run_id", MIN("file_created_at") AS min_created
  FROM "files"
  WHERE "file_created_at" IS NOT NULL
  GROUP BY "instrument_run_id"
) sub
WHERE ir."id" = sub."instrument_run_id" AND ir."acquired_at" IS NULL;
