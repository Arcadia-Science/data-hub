ALTER TABLE "personal_access_tokens" DROP CONSTRAINT "personal_access_tokens_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "idx_personal_access_tokens_user_id";--> statement-breakpoint
ALTER TABLE "personal_access_tokens" DROP COLUMN "user_id";--> statement-breakpoint
-- Migration 0050 added these constraints NOT VALID so its deploy would not
-- scan large tables while holding locks. This runs in a separate, later
-- deploy and checks the existing rows. VALIDATE only blocks schema changes,
-- not reads or writes.
ALTER TABLE "archive_jobs" VALIDATE CONSTRAINT "archive_jobs_created_by_token_personal_access_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "instrument_runs" VALIDATE CONSTRAINT "instrument_runs_deleted_by_token_personal_access_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "instruments" VALIDATE CONSTRAINT "instruments_retired_by_token_personal_access_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_actor_token_id_personal_access_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "run_comments" VALIDATE CONSTRAINT "run_comments_token_id_personal_access_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "watchers" VALIDATE CONSTRAINT "watchers_deregistered_by_token_personal_access_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "archive_jobs" VALIDATE CONSTRAINT "archive_jobs_one_creator";--> statement-breakpoint
ALTER TABLE "instrument_runs" VALIDATE CONSTRAINT "instrument_runs_one_deleter";--> statement-breakpoint
ALTER TABLE "instruments" VALIDATE CONSTRAINT "instruments_one_retirer";--> statement-breakpoint
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_one_actor";--> statement-breakpoint
ALTER TABLE "run_comments" VALIDATE CONSTRAINT "run_comments_one_author";--> statement-breakpoint
ALTER TABLE "watchers" VALIDATE CONSTRAINT "watchers_one_deregisterer";
