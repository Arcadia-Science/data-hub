-- Pre-flight: ensure at most one active row per (instrument_run_id, filename)
-- before creating the partial unique index. Watcher and Lambda writers
-- previously deduped on disjoint partial indexes (relative_path vs s3_key),
-- so the same physical file could land twice. Soft-delete the redundant rows
-- here; "best" preference order:
--   1. has an s3_key (already in S3)
--   2. status priority: completed > processing > uploaded > failed >
--      upload_requested > detected
--   3. earliest created_at, lowest id as final tiebreaker
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY instrument_run_id, filename
           ORDER BY (s3_key IS NOT NULL) DESC,
                    CASE status
                      WHEN 'completed' THEN 1
                      WHEN 'processing' THEN 2
                      WHEN 'uploaded' THEN 3
                      WHEN 'failed' THEN 4
                      WHEN 'upload_requested' THEN 5
                      WHEN 'detected' THEN 6
                    END,
                    created_at ASC,
                    id ASC
         ) AS rn
  FROM files
  WHERE deleted_at IS NULL
)
UPDATE files
SET deleted_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_files_active_instrument_run_id_filename" ON "files" USING btree ("instrument_run_id","filename") WHERE "files"."deleted_at" is null;