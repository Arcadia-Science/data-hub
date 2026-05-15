CREATE TABLE "run_attributions" (
	"run_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_attributions_run_id_user_id_pk" PRIMARY KEY("run_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "run_attributions" ADD CONSTRAINT "run_attributions_run_id_instrument_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."instrument_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attributions" ADD CONSTRAINT "run_attributions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_attributions_run_id" ON "run_attributions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_run_attributions_user_id" ON "run_attributions" USING btree ("user_id");