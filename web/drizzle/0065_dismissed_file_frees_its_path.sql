-- Drizzle runs every pending migration in one transaction, so locks taken here
-- are held until the end. Failing fast beats stalling the app behind a lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- A dismissed file no longer holds its path. The unique index on a file's path
-- within a run covers active rows only, like the one on the filename, so a
-- different file found at a dismissed file's path can be stored. The new
-- index covers fewer rows than the old one, so existing data always fits it.
-- The new index is built first. The build takes a lock that lets reads
-- continue and makes writes wait, and the drop, which blocks reads as well,
-- then holds its lock only until the commit.
CREATE UNIQUE INDEX "uq_files_active_instrument_run_id_relative_path" ON "files" USING btree ("instrument_run_id","relative_path") WHERE "files"."relative_path" is not null and "files"."deleted_at" is null;--> statement-breakpoint
DROP INDEX "uq_files_instrument_run_id_relative_path";