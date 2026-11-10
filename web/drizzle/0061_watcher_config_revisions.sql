CREATE TYPE "public"."watcher_config_revision_source" AS ENUM('web', 'pc');--> statement-breakpoint
CREATE TYPE "public"."watcher_config_revision_status" AS ENUM('pending', 'applied', 'rejected', 'superseded');--> statement-breakpoint
ALTER TYPE "public"."watcher_status" ADD VALUE 'waiting';--> statement-breakpoint
CREATE TABLE "watcher_config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watcher_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"source" "watcher_config_revision_source" NOT NULL,
	"settings" jsonb NOT NULL,
	"status" "watcher_config_revision_status" NOT NULL,
	"status_reason" text,
	"created_by" text,
	"created_by_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "uq_watcher_config_revisions_watcher_revision" UNIQUE("watcher_id","revision"),
	CONSTRAINT "watcher_config_revisions_one_creator" CHECK (num_nonnulls("watcher_config_revisions"."created_by", "watcher_config_revisions"."created_by_token") <= 1)
);
--> statement-breakpoint
ALTER TABLE "watchers" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "watchers" ADD COLUMN "config_revision" integer;--> statement-breakpoint
ALTER TABLE "watchers" ADD COLUMN "applied_config_revision" integer;--> statement-breakpoint
ALTER TABLE "watcher_config_revisions" ADD CONSTRAINT "watcher_config_revisions_watcher_id_watchers_id_fk" FOREIGN KEY ("watcher_id") REFERENCES "public"."watchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watcher_config_revisions" ADD CONSTRAINT "watcher_config_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watcher_config_revisions" ADD CONSTRAINT "watcher_config_revisions_created_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("created_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;