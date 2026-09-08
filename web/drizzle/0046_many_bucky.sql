ALTER TYPE "public"."notification_type" ADD VALUE 'generic';--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "generic_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "slack_generic_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "body" text;