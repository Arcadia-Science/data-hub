CREATE TYPE "public"."archive_job_status" AS ENUM('pending', 'building', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "archive_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_run_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"archive_bucket" text,
	"archive_key" text,
	"size_bytes" bigint,
	"status" "archive_job_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "archive_jobs" ADD CONSTRAINT "archive_jobs_instrument_run_id_instrument_runs_id_fk" FOREIGN KEY ("instrument_run_id") REFERENCES "public"."instrument_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_jobs" ADD CONSTRAINT "archive_jobs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_archive_jobs_inflight" ON "archive_jobs" USING btree ("instrument_run_id","fingerprint") WHERE "archive_jobs"."status" in ('pending', 'building');--> statement-breakpoint
CREATE INDEX "idx_archive_jobs_run_fingerprint_status" ON "archive_jobs" USING btree ("instrument_run_id","fingerprint","status");