CREATE TABLE "run_notebook_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_key" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"created_by_token" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_by_token" uuid,
	CONSTRAINT "uq_run_notebook_links_run_id_url_key" UNIQUE("run_id","url_key"),
	CONSTRAINT "run_notebook_links_one_creator" CHECK (num_nonnulls("run_notebook_links"."created_by", "run_notebook_links"."created_by_token") <= 1),
	CONSTRAINT "run_notebook_links_one_updater" CHECK (num_nonnulls("run_notebook_links"."updated_by", "run_notebook_links"."updated_by_token") <= 1)
);
--> statement-breakpoint
ALTER TABLE "run_notebook_links" ADD CONSTRAINT "run_notebook_links_run_id_instrument_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."instrument_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_notebook_links" ADD CONSTRAINT "run_notebook_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_notebook_links" ADD CONSTRAINT "run_notebook_links_created_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("created_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_notebook_links" ADD CONSTRAINT "run_notebook_links_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_notebook_links" ADD CONSTRAINT "run_notebook_links_updated_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("updated_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_notebook_links_url_key_trgm" ON "run_notebook_links" USING gin ("url_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_run_notebook_links_url_trgm" ON "run_notebook_links" USING gin ("url" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_run_notebook_links_label_trgm" ON "run_notebook_links" USING gin ("label" gin_trgm_ops) WHERE "run_notebook_links"."label" is not null;