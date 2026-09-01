ALTER TABLE "account" DROP CONSTRAINT "uq_account_issuer_account_id";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
