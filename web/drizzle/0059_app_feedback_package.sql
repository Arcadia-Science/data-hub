ALTER TABLE "linear_integration_config" DROP CONSTRAINT "linear_integration_config_updated_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "start_factory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "factory_label_id" text;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "test_report_id" text;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "test_report_outcome" text;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD COLUMN "test_report_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linear_integration_config" ADD CONSTRAINT "linear_test_report_outcome" CHECK ("linear_integration_config"."test_report_outcome" is null or "linear_integration_config"."test_report_outcome" in ('delivered', 'disabled', 'none'));