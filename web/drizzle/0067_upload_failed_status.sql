CREATE TYPE "public"."upload_failure_reason" AS ENUM('folder_missing', 'file_missing', 'upload_error', 'unsafe_path');--> statement-breakpoint
ALTER TYPE "public"."file_status" ADD VALUE 'upload_failed' BEFORE 'uploaded';--> statement-breakpoint
ALTER TYPE "public"."watcher_event_type" ADD VALUE 'uploads_failed';--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "upload_failure_reason" "upload_failure_reason";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "upload_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "upload_requested_by" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "auto_upload_expected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_upload_requested_by_user_id_fk" FOREIGN KEY ("upload_requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_files_auto_upload_expected" ON "files" USING btree ("instrument_run_id") WHERE "files"."auto_upload_expected_at" is not null;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_upload_failure_matches_status" CHECK (("files"."status"::text = 'upload_failed') = ("files"."upload_failure_reason" is not null and "files"."upload_failed_at" is not null));--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_auto_upload_mark_before_upload" CHECK ("files"."auto_upload_expected_at" is null or "files"."status"::text in ('detected', 'upload_requested'));--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_upload_requester_has_request" CHECK ("files"."upload_requested_by" is null or "files"."upload_requested_at" is not null);