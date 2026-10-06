ALTER TABLE "personal_access_tokens" DROP CONSTRAINT "personal_access_tokens_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "idx_personal_access_tokens_user_id";--> statement-breakpoint
ALTER TABLE "personal_access_tokens" DROP COLUMN "user_id";