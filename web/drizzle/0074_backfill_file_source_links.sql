-- The Lambda now says which raw file each processed file was made from
-- (`files.source_file_id`). This links the processed files that already exist,
-- by file name, so deleting a raw file can offer them too.
--
-- A processed file is linked to the raw file of its run that has the same name
-- apart from the extension: `s001_A.tif` made `s001_A.mp4` and `s001_A.jpg`. The
-- Epson scanner's colony table is `s001_A_colonies.csv`. A processed file that
-- matches no raw file, or more than one, is left unlinked, because a wrong link
-- would offer the wrong file for deletion. Raw sidecars (`.json`) and rows with
-- no S3 key never make output, so they are not candidates. Deleted rows are
-- included on both sides, so a restore finds its links too.
--
-- It only fills rows that have no source yet, so it can run again and never
-- changes a link the Lambda set. Each join compares values with `=`, so
-- Postgres can hash-join the files of a large run instead of comparing every
-- pair.
--
-- Drizzle applies every pending migration in one transaction. When this runs
-- with 0073, the update happens while 0073's lock on "files" is held, so reads
-- and writes of files wait for it. It rewrites one row per linked processed
-- file, which took about 15 seconds for 400,000 of them on a laptop.
WITH raw_stems AS (
	SELECT "id", "instrument_run_id", regexp_replace("filename", '\.[^.]*$', '') AS "stem"
	FROM "files"
	WHERE "category" = 'raw'
		AND "s3_key" IS NOT NULL
		AND "filename" NOT ILIKE '%.json'
),
processed_stems AS (
	SELECT "id", "instrument_run_id", regexp_replace("filename", '\.[^.]*$', '') AS "stem"
	FROM "files"
	WHERE "category" = 'processed'
		AND "source_file_id" IS NULL
),
matches AS (
	SELECT p."id" AS "processed_id", r."id" AS "raw_id"
	FROM processed_stems p
	JOIN raw_stems r
		ON r."instrument_run_id" = p."instrument_run_id" AND r."stem" = p."stem"
	UNION ALL
	SELECT p."id" AS "processed_id", r."id" AS "raw_id"
	FROM processed_stems p
	JOIN raw_stems r
		ON r."instrument_run_id" = p."instrument_run_id" AND r."stem" || '_colonies' = p."stem"
),
only_match AS (
	SELECT "processed_id", min("raw_id") AS "raw_id"
	FROM matches
	GROUP BY "processed_id"
	HAVING count(*) = 1
)
UPDATE "files"
SET "source_file_id" = only_match."raw_id"
FROM only_match
WHERE "files"."id" = only_match."processed_id"
	AND "files"."source_file_id" IS NULL;
