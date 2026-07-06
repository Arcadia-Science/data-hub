-- Trigram matching support for global search. `gin_trgm_ops` below is only
-- available once this extension exists. Drizzle does not manage extensions, so
-- it is created here (and, for the `drizzle-kit push` paths used by local
-- reseed and integration tests, in reset-database.ts / the test global-setup).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "idx_files_filename_trgm" ON "files" USING gin ("filename" gin_trgm_ops) WHERE "files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_instrument_runs_run_id_trgm" ON "instrument_runs" USING gin ("run_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_instruments_display_name_trgm" ON "instruments" USING gin ("display_name" gin_trgm_ops);