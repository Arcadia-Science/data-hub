ALTER TABLE "files" ADD COLUMN "dispatch_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "stall_requeues" smallint DEFAULT 0 NOT NULL;