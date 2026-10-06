-- Claiming runs and triaging feedback now need a signed-in person, so tokens
-- can no longer hold these scopes. Strip them from existing tokens.
UPDATE "personal_access_tokens"
SET "scopes" = array_remove(array_remove("scopes", 'runs:attribute'), 'feedback:admin')
WHERE "scopes" && ARRAY['runs:attribute', 'feedback:admin'];--> statement-breakpoint
-- Tokens whose owner was deleted while the previous release was live have no
-- owner and could not sign in there. Revoke them once so they do not start
-- working again now that tokens act as themselves. Safe only because new
-- tokens still record their creator in user_id, so NULL here means the owner
-- was already gone before this release.
UPDATE "personal_access_tokens"
SET "revoked_at" = now()
WHERE "user_id" IS NULL AND "revoked_at" IS NULL;
