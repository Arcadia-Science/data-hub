-- Claiming runs and triaging feedback now need a signed-in person, so tokens
-- can no longer hold these scopes. Strip them from existing tokens.
UPDATE "personal_access_tokens"
SET "scopes" = array_remove(array_remove("scopes", 'runs:attribute'), 'feedback:admin')
WHERE "scopes" && ARRAY['runs:attribute', 'feedback:admin'];
