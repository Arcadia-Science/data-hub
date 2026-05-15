CREATE TABLE "run_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "run_comments" ADD CONSTRAINT "run_comments_run_id_instrument_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."instrument_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_comments" ADD CONSTRAINT "run_comments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_comments_run_id_created_at" ON "run_comments" USING btree ("run_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_run_comments_user_id" ON "run_comments" USING btree ("user_id");