CREATE TABLE "slack_channel_config" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"webhook_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "slack_channel_config_singleton" CHECK ("slack_channel_config"."id" = true)
);
--> statement-breakpoint
ALTER TABLE "slack_channel_config" ADD CONSTRAINT "slack_channel_config_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;