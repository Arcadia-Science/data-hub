CREATE TABLE "watcher_release_config" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"latest_version" text,
	"min_supported_version" text,
	"channel" text DEFAULT 'stable' NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "watcher_release_config_singleton" CHECK ("watcher_release_config"."id" = true)
);
--> statement-breakpoint
ALTER TABLE "watcher_release_config" ADD CONSTRAINT "watcher_release_config_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;