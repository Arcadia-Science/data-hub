CREATE TYPE "public"."file_category" AS ENUM('raw', 'processed');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('detected', 'upload_requested', 'uploaded', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."instrument_run_source" AS ENUM('lambda', 'watcher');--> statement-breakpoint
CREATE TYPE "public"."instrument_status" AS ENUM('pending', 'active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."upload_mode" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."watcher_event_type" AS ENUM('watcher_started', 'watcher_stopped', 'file_uploaded', 'upload_failed', 'run_reported', 'config_synced', 'error');--> statement-breakpoint
CREATE TYPE "public"."watcher_status" AS ENUM('registered', 'watching', 'stopped');--> statement-breakpoint
CREATE TABLE "account" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"instrument_run_id" uuid NOT NULL,
	"relative_path" text,
	"s3_bucket" text,
	"s3_key" text,
	"filename" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint,
	"category" "file_category" DEFAULT 'raw' NOT NULL,
	"status" "file_status" DEFAULT 'detected' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"detected_at" timestamp with time zone,
	"upload_requested_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "instrument_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" text NOT NULL,
	"run_id" text NOT NULL,
	"source" "instrument_run_source" DEFAULT 'lambda' NOT NULL,
	"watcher_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"files_purged_at" timestamp with time zone,
	CONSTRAINT "uq_instrument_runs_instrument_id_run_id" UNIQUE("instrument_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"status" "instrument_status" DEFAULT 'active' NOT NULL,
	"file_patterns" text[],
	"s3_trigger_suffix" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "run_report_data" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"instrument_run_id" uuid NOT NULL,
	"file_id" bigint,
	"data_type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp,
	"image" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "watcher_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"watcher_id" uuid NOT NULL,
	"event_type" "watcher_event_type" NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watcher_heartbeats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"watcher_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"upload_mode" "upload_mode",
	"files_uploaded_since_last" integer DEFAULT 0,
	"runs_reported_since_last" integer DEFAULT 0,
	"errors_since_last" integer DEFAULT 0,
	"uptime_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" text NOT NULL,
	"hostname" text,
	"os_info" text,
	"config_checksum" text,
	"config_yaml" text,
	"last_heartbeat_at" timestamp with time zone,
	"status" "watcher_status" DEFAULT 'registered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_instrument_run_id_instrument_runs_id_fk" FOREIGN KEY ("instrument_run_id") REFERENCES "public"."instrument_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_runs" ADD CONSTRAINT "instrument_runs_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_runs" ADD CONSTRAINT "instrument_runs_watcher_id_watchers_id_fk" FOREIGN KEY ("watcher_id") REFERENCES "public"."watchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_report_data" ADD CONSTRAINT "run_report_data_instrument_run_id_instrument_runs_id_fk" FOREIGN KEY ("instrument_run_id") REFERENCES "public"."instrument_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_report_data" ADD CONSTRAINT "run_report_data_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watcher_events" ADD CONSTRAINT "watcher_events_watcher_id_watchers_id_fk" FOREIGN KEY ("watcher_id") REFERENCES "public"."watchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watcher_heartbeats" ADD CONSTRAINT "watcher_heartbeats_watcher_id_watchers_id_fk" FOREIGN KEY ("watcher_id") REFERENCES "public"."watchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchers" ADD CONSTRAINT "watchers_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_accounts_user_id" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_files_instrument_run_id_relative_path" ON "files" USING btree ("instrument_run_id","relative_path") WHERE "files"."relative_path" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_files_s3_key" ON "files" USING btree ("s3_key") WHERE "files"."s3_key" is not null;--> statement-breakpoint
CREATE INDEX "idx_files_instrument_run_id" ON "files" USING btree ("instrument_run_id");--> statement-breakpoint
CREATE INDEX "idx_files_status_instrument_run_id" ON "files" USING btree ("status","instrument_run_id");--> statement-breakpoint
CREATE INDEX "idx_files_active" ON "files" USING btree ("instrument_run_id") WHERE "files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_files_upload_queue" ON "files" USING btree ("upload_requested_at") WHERE "files"."upload_requested_at" is not null and "files"."uploaded_at" is null and "files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_files_metadata_gin" ON "files" USING gin ("metadata");--> statement-breakpoint
CREATE INDEX "idx_instrument_runs_instrument_id_created_at" ON "instrument_runs" USING btree ("instrument_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_instrument_runs_active" ON "instrument_runs" USING btree ("instrument_id","created_at" DESC NULLS LAST) WHERE "instrument_runs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_instrument_runs_metadata_gin" ON "instrument_runs" USING gin ("metadata");--> statement-breakpoint
CREATE INDEX "idx_personal_access_tokens_user_id" ON "personal_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_run_report_data_instrument_run_id" ON "run_report_data" USING btree ("instrument_run_id");--> statement-breakpoint
CREATE INDEX "idx_run_report_data_file_id" ON "run_report_data" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_watcher_events_watcher_id_timestamp" ON "watcher_events" USING btree ("watcher_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_watcher_events_watcher_id_event_type" ON "watcher_events" USING btree ("watcher_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_watcher_heartbeats_watcher_id_timestamp" ON "watcher_heartbeats" USING btree ("watcher_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_watchers_instrument_id" ON "watchers" USING btree ("instrument_id") WHERE "watchers"."deleted_at" is null;