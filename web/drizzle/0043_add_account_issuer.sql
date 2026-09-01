-- Better Auth 1.7 keys accounts on (issuer, accountId). Add the column
-- nullable, backfill existing rows, then tighten the constraint.
ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint
UPDATE "account"
SET "issuer" = 'local:credential'
WHERE "providerId" = 'credential';--> statement-breakpoint
UPDATE "account"
SET "issuer" = 'https://accounts.google.com'
WHERE "providerId" = 'google';--> statement-breakpoint
-- Any other OAuth provider Better Auth 1.7 would namespace as local:oauth:<id>.
UPDATE "account"
SET "issuer" = 'local:oauth:' || "providerId"
WHERE "issuer" IS NULL;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "uq_account_issuer_account_id" UNIQUE("issuer","accountId");
