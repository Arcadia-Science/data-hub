CREATE TABLE "linear_integration_config" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"client_id" text,
	"client_secret" text,
	"webhook_secret" text,
	"team_id" text,
	"team_name" text,
	"project_id" text,
	"project_name" text,
	"bug_label_id" text,
	"bug_label_name" text,
	"feature_label_id" text,
	"feature_label_name" text,
	"other_label_id" text,
	"other_label_name" text,
	"last_webhook_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "linear_integration_config_singleton" CHECK ("linear_integration_config"."id" = true)
);
--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD CONSTRAINT "linear_integration_config_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;