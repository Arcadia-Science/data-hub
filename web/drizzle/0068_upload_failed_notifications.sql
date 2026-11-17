ALTER TYPE "public"."notification_type" ADD VALUE 'upload_failed';--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "upload_failed_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "slack_upload_failed_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Connecting Slack turns every Slack toggle on, so users who have already
-- connected get this one on too.
UPDATE "notification_preferences" SET "slack_upload_failed_enabled" = true WHERE "user_id" IN (SELECT "user_id" FROM "slack_connections" WHERE "revoked_at" IS NULL);