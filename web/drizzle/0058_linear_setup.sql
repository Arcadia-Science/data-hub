ALTER TABLE "linear_integration_config" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "workspace_name" text;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "workspace_url_key" text;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "team_key" text;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "project_url" text;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "webhook_rejections" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "last_webhook_rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "last_webhook_rejection_reason" text;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD CONSTRAINT "linear_webhook_rejection_reason" CHECK ("linear_integration_config"."last_webhook_rejection_reason" is null or "linear_integration_config"."last_webhook_rejection_reason" in ('signature', 'stale'));