ALTER TYPE "public"."notification_type" ADD VALUE 'instrument_offline';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'instrument_back_online';--> statement-breakpoint
CREATE TABLE "instrument_offline_alerts" (
	"instrument_id" text PRIMARY KEY NOT NULL,
	"offline_since" timestamp with time zone NOT NULL,
	"alerted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "instrument_offline_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "slack_instrument_offline_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "instrument_id" text;--> statement-breakpoint
ALTER TABLE "instrument_offline_alerts" ADD CONSTRAINT "instrument_offline_alerts_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Connecting Slack turns every Slack toggle on, so users who have already
-- connected get this one on too.
UPDATE "notification_preferences" SET "slack_instrument_offline_enabled" = true WHERE "user_id" IN (SELECT "user_id" FROM "slack_connections" WHERE "revoked_at" IS NULL);
