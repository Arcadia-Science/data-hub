CREATE TYPE "public"."feedback_kind" AS ENUM('bug', 'feature_request', 'other');--> statement-breakpoint
CREATE TYPE "public"."feedback_source" AS ENUM('mcp', 'web');--> statement-breakpoint
CREATE TYPE "public"."feedback_status" AS ENUM('open', 'resolved', 'declined');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'feedback_submitted';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'feedback_updated';--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"kind" "feedback_kind" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"attempted_action" text,
	"tool_name" text,
	"error_message" text,
	"source" "feedback_source" NOT NULL,
	"oauth_client_id" text,
	"page_url" text,
	"status" "feedback_status" DEFAULT 'open' NOT NULL,
	"admin_note" text,
	"status_updated_by" text,
	"status_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "feedback_submitted_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "feedback_updated_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "slack_feedback_submitted_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "slack_feedback_updated_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "feedback_id" uuid;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_status_updated_by_user_id_fk" FOREIGN KEY ("status_updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feedback_status_created_at" ON "feedback" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_feedback_user_id_created_at" ON "feedback" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;