-- Pre-flight: ensure at most one active watcher per instrument before
-- creating the partial unique index. For any (instrument_id) with multiple
-- active rows, keep the most recently created and soft-delete the rest.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY instrument_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM watchers
  WHERE deleted_at IS NULL
)
UPDATE watchers
SET deleted_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
DROP INDEX "idx_watchers_instrument_id";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_watchers_active_instrument_id" ON "watchers" USING btree ("instrument_id") WHERE "watchers"."deleted_at" is null;