-- Tokens minted before the fine-grained scope split can carry `*` or a coarse
-- `:write` scope. On a token that registered a watcher, those now count only
-- for what a watcher needs (`narrowWatcherTokenScopes` in
-- web/lib/api/watcher-binding.ts). Store the narrowed scopes as well, so the
-- Tokens page shows what each of these tokens can do. The lists below copy the
-- Watcher preset and the legacy expansions as they are in this release.
-- Scopes the token lists explicitly are kept.
UPDATE "personal_access_tokens" AS "token"
SET "scopes" = ARRAY(
  SELECT DISTINCT "candidate"."scope"
  FROM (
    SELECT unnest("token"."scopes") AS "scope"
    UNION ALL
    SELECT unnest(ARRAY[
      'instruments:read',
      'instruments:write',
      'watchers:read',
      'watchers:report',
      'runs:create',
      'runs:update',
      'runs:upload',
      'files:update'
    ])
    WHERE '*' = ANY("token"."scopes")
    UNION ALL
    SELECT unnest(ARRAY['runs:create', 'runs:update', 'runs:upload'])
    WHERE 'runs:write' = ANY("token"."scopes")
    UNION ALL
    SELECT 'files:update'
    WHERE 'files:write' = ANY("token"."scopes")
    UNION ALL
    SELECT 'watchers:report'
    WHERE 'watchers:write' = ANY("token"."scopes")
  ) AS "candidate"
  WHERE "candidate"."scope" NOT IN ('*', 'runs:write', 'files:write', 'watchers:write')
  ORDER BY "candidate"."scope"
)
WHERE "token"."revoked_at" IS NULL
  AND "token"."scopes" && ARRAY['*', 'runs:write', 'files:write', 'watchers:write']
  AND EXISTS (
    SELECT 1
    FROM "watchers"
    WHERE "watchers"."registered_by_token" = "token"."id"
  );
