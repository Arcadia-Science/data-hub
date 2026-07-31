-- Migrate Auth.js tables to Better Auth in place, preserving every `user.id`
-- so foreign keys (run attributions, comments, PATs, notifications, …) stay
-- intact. Auth.js was on JWT sessions, so `session` is empty at runtime and
-- safe to drop/recreate.

-- ---------------------------------------------------------------------------
-- user
-- ---------------------------------------------------------------------------
UPDATE "user"
SET
  "name" = COALESCE("name", split_part("email", '@', 1), 'User')
WHERE "name" IS NULL;
--> statement-breakpoint
UPDATE "user"
SET
  "email" = CONCAT('missing-', "id", '@invalid.local')
WHERE "email" IS NULL;
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "emailVerified" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "emailVerified" SET DATA TYPE boolean USING ("emailVerified" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "emailVerified" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "emailVerified" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "createdAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "updatedAt" timestamp DEFAULT now() NOT NULL;

-- ---------------------------------------------------------------------------
-- account — reshape Auth.js composite-PK / snake_case into Better Auth
-- ---------------------------------------------------------------------------
ALTER TABLE "account" DROP CONSTRAINT "account_provider_providerAccountId_pk";--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "id" text;--> statement-breakpoint
UPDATE "account" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "accountId" text;--> statement-breakpoint
UPDATE "account" SET "accountId" = "providerAccountId";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "accountId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "providerId" text;--> statement-breakpoint
UPDATE "account" SET "providerId" = "provider";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "providerId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "accessToken" text;--> statement-breakpoint
UPDATE "account" SET "accessToken" = "access_token";--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "refreshToken" text;--> statement-breakpoint
UPDATE "account" SET "refreshToken" = "refresh_token";--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "idToken" text;--> statement-breakpoint
UPDATE "account" SET "idToken" = "id_token";--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "accessTokenExpiresAt" timestamp;--> statement-breakpoint
UPDATE "account"
SET
  "accessTokenExpiresAt" = to_timestamp("expires_at")
WHERE "expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "refreshTokenExpiresAt" timestamp;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "password" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "createdAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "updatedAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "provider";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "providerAccountId";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "refresh_token";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "access_token";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "token_type";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "id_token";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "session_state";--> statement-breakpoint
ALTER TABLE "account" ADD PRIMARY KEY ("id");

-- ---------------------------------------------------------------------------
-- session — unused under Auth.js JWT strategy; recreate for Better Auth
-- ---------------------------------------------------------------------------
DROP TABLE "session" CASCADE;--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"userId" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "session" USING btree ("userId");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_token_unique" UNIQUE("token");

-- ---------------------------------------------------------------------------
-- verification — dropped in 0003; Better Auth needs it again
-- ---------------------------------------------------------------------------
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
