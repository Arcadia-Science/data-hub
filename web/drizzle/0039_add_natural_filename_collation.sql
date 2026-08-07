-- Numeric-aware ordering for report items: without it `Site_10` sorts before
-- `Site_2`. Mirrored in reset-database.ts / global-setup.ts for the push paths.
DO $$
BEGIN
  CREATE COLLATION IF NOT EXISTS natural_filename (provider = icu, locale = 'en-US-u-kn');
EXCEPTION WHEN OTHERS THEN
  -- Postgres built without ICU falls back to the database default: plain
  -- lexicographic, but every ORDER BY referencing it still resolves.
  CREATE COLLATION IF NOT EXISTS natural_filename FROM pg_catalog."default";
END $$;
