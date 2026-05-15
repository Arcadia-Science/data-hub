CREATE TYPE "public"."instrument_type" AS ENUM('generic', 'plate_reader');--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "instrument_type" "instrument_type" DEFAULT 'generic' NOT NULL;