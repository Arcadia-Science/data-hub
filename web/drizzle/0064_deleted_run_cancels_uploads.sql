ALTER TYPE "public"."watcher_event_type" ADD VALUE 'upload_requests_cancelled';--> statement-breakpoint
-- Deleting a run now cancels its requested uploads. Cancel the ones that were
-- left behind by earlier deletes: files that still wait in the upload queue
-- although their run is deleted. The watcher cannot upload them, so they
-- would stay in its queue for good. Each goes back to `detected`, like any
-- other cancelled request. Running this twice changes nothing.
UPDATE "files"
SET "status" = 'detected', "upload_requested_at" = NULL
WHERE "status" = 'upload_requested'
  AND "uploaded_at" IS NULL
  AND "deleted_at" IS NULL
  AND "instrument_run_id" IN (
    SELECT "id" FROM "instrument_runs" WHERE "deleted_at" IS NOT NULL
  );
