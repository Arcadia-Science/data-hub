ALTER TABLE "instruments" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "retired_by" text;--> statement-breakpoint
ALTER TABLE "watchers" ADD COLUMN "deregistered_by" text;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchers" ADD CONSTRAINT "watchers_deregistered_by_user_id_fk" FOREIGN KEY ("deregistered_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;