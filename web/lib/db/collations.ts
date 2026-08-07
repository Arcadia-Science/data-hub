// Numeric-aware collation for filename ordering: without it `Site_10` sorts
// before `Site_2` wherever filenames are not zero-padded.
export const NATURAL_FILENAME_COLLATION = "natural_filename";

// Owned by migration 0039. Drizzle does not manage collations, so the
// `drizzle-kit push` paths run the same statement after dropping the schema.
export const CREATE_NATURAL_FILENAME_COLLATION = `
DO $$
BEGIN
  CREATE COLLATION IF NOT EXISTS ${NATURAL_FILENAME_COLLATION} (provider = icu, locale = 'en-US-u-kn');
EXCEPTION WHEN OTHERS THEN
  -- Postgres built without ICU falls back to the database default: plain
  -- lexicographic, but every ORDER BY referencing it still resolves.
  CREATE COLLATION IF NOT EXISTS ${NATURAL_FILENAME_COLLATION} FROM pg_catalog."default";
END $$;
`;
