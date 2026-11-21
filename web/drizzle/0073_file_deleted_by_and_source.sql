-- Drizzle runs every pending migration in one transaction, so locks taken here
-- are held until the end. Failing fast beats stalling the app behind a lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- Who deleted a file, and which raw file a processed file was made from. A new
-- column with no default is a catalog change, so the table is not rewritten.
ALTER TABLE "files" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "deleted_by_token" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "source_file_id" bigint;--> statement-breakpoint
-- The new columns are all NULL, so there is nothing to check yet. Adding these
-- constraints NOT VALID skips a scan of the large files table while the lock
-- is held. New rows are still checked. A later, separate deploy validates them.
ALTER TABLE "files" ADD CONSTRAINT "files_one_deleter" CHECK (num_nonnulls("files"."deleted_by", "files"."deleted_by_token") <= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_source_file_id_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
-- Partial, because raw files and outputs of a whole run have no source. The
-- build reads the table once, which the lock above already makes everyone wait
-- for.
CREATE INDEX "idx_files_source_file_id" ON "files" USING btree ("source_file_id") WHERE "files"."source_file_id" is not null;--> statement-breakpoint
-- Last, because these are the only statements that lock the "user" and
-- "personal_access_tokens" tables. Like the lock on "files", those locks last
-- until the transaction commits, and that includes 0074's backfill when both
-- migrations are applied together.
ALTER TABLE "files" ADD CONSTRAINT "files_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_deleted_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("deleted_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
