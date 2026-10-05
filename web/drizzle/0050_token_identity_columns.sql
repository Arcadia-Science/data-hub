ALTER TABLE "personal_access_tokens" DROP CONSTRAINT "personal_access_tokens_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_comments" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_jobs" ADD COLUMN "created_by_token" uuid;--> statement-breakpoint
ALTER TABLE "instrument_runs" ADD COLUMN "deleted_by_token" uuid;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "retired_by_token" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "actor_token_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_comments" ADD COLUMN "token_id" uuid;--> statement-breakpoint
ALTER TABLE "watchers" ADD COLUMN "deregistered_by_token" uuid;--> statement-breakpoint
ALTER TABLE "archive_jobs" ADD CONSTRAINT "archive_jobs_created_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("created_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_runs" ADD CONSTRAINT "instrument_runs_deleted_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("deleted_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_retired_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("retired_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_token_id_personal_access_tokens_id_fk" FOREIGN KEY ("actor_token_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_comments" ADD CONSTRAINT "run_comments_token_id_personal_access_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchers" ADD CONSTRAINT "watchers_deregistered_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("deregistered_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_personal_access_tokens_created_by" ON "personal_access_tokens" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "archive_jobs" ADD CONSTRAINT "archive_jobs_one_creator" CHECK (num_nonnulls("archive_jobs"."created_by", "archive_jobs"."created_by_token") <= 1);--> statement-breakpoint
ALTER TABLE "instrument_runs" ADD CONSTRAINT "instrument_runs_one_deleter" CHECK (num_nonnulls("instrument_runs"."deleted_by", "instrument_runs"."deleted_by_token") <= 1);--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_one_retirer" CHECK (num_nonnulls("instruments"."retired_by", "instruments"."retired_by_token") <= 1);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_one_actor" CHECK (num_nonnulls("notifications"."actor_user_id", "notifications"."actor_token_id") <= 1);--> statement-breakpoint
ALTER TABLE "run_comments" ADD CONSTRAINT "run_comments_one_author" CHECK (num_nonnulls("run_comments"."user_id", "run_comments"."token_id") = 1);--> statement-breakpoint
ALTER TABLE "watchers" ADD CONSTRAINT "watchers_one_deregisterer" CHECK (num_nonnulls("watchers"."deregistered_by", "watchers"."deregistered_by_token") <= 1);--> statement-breakpoint
-- Existing tokens were created by their owner or by an admin on their behalf;
-- the owner is the best record of who created each one.
UPDATE "personal_access_tokens" SET "created_by" = "user_id";
