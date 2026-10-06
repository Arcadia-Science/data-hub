CREATE TABLE "slack_app_config" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"bot_token" text,
	"client_id" text,
	"client_secret" text,
	"team_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "slack_app_config_singleton" CHECK ("slack_app_config"."id" = true)
);
--> statement-breakpoint
ALTER TABLE "slack_app_config" ADD CONSTRAINT "slack_app_config_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;