DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "feedback" LIMIT 1) THEN
    RAISE EXCEPTION 'Refusing to drop feedback because it still has rows';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_feedback_id_feedback_id_fk";
--> statement-breakpoint
DROP TABLE "feedback";
--> statement-breakpoint
DROP TYPE "public"."feedback_kind";
--> statement-breakpoint
DROP TYPE "public"."feedback_source";
--> statement-breakpoint
DROP TYPE "public"."feedback_status";
