ALTER TYPE "public"."file_status" ADD VALUE 'queued' BEFORE 'processing';--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "queued_at" timestamp with time zone;