-- Lab notebooks become their own rows. Until now each run held its own link
-- rows, tied to other runs' links to the same page only by `url_key`. This
-- migration makes one `notebooks` row per page and turns `run_notebook_links`
-- into a join of runs to notebooks:
-- - url: the page's newest link.
-- - name: the label used on the most of the page's links, ties going to the
--   newest. A page with no label is named after the page name in its URL,
--   or its site, the way `notebookNameFromUrl` does.
-- - created: the page's earliest link and who added it. updated: its most
--   recently changed link.
-- - owner: the person attributed to the most of the page's live runs, ties
--   going to whoever ran the most recent of the tied runs. None when no live
--   run has an attribution.
-- Tokens that carried `runs:link` carry `notebooks:write` instead.
CREATE TABLE "notebooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"url_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"created_by_token" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_by_token" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"deleted_by_token" uuid,
	CONSTRAINT "uq_notebooks_url_key" UNIQUE("url_key"),
	CONSTRAINT "notebooks_one_creator" CHECK (num_nonnulls("notebooks"."created_by", "notebooks"."created_by_token") <= 1),
	CONSTRAINT "notebooks_one_updater" CHECK (num_nonnulls("notebooks"."updated_by", "notebooks"."updated_by_token") <= 1),
	CONSTRAINT "notebooks_one_deleter" CHECK (num_nonnulls("notebooks"."deleted_by", "notebooks"."deleted_by_token") <= 1)
);
--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_created_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("created_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_updated_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("updated_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_deleted_by_token_personal_access_tokens_id_fk" FOREIGN KEY ("deleted_by_token") REFERENCES "public"."personal_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notebooks_owner_id" ON "notebooks" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_notebooks_name_trgm" ON "notebooks" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_notebooks_url_key_trgm" ON "notebooks" USING gin ("url_key" gin_trgm_ops);--> statement-breakpoint
-- Percent-decodes a path segment the way `decodeURIComponent` does, or
-- returns it unchanged when it isn't valid percent-encoded UTF-8.
CREATE FUNCTION pg_temp.notebook_url_decode(input text) RETURNS text AS $$
DECLARE
	bytes bytea := '';
	i integer := 1;
	n integer := length(input);
	c text;
BEGIN
	IF input ~ '%(?![0-9A-Fa-f]{2})' THEN
		RETURN input;
	END IF;
	WHILE i <= n LOOP
		c := substr(input, i, 1);
		IF c = '%' THEN
			bytes := bytes || decode(substr(input, i + 1, 2), 'hex');
			i := i + 3;
		ELSE
			bytes := bytes || convert_to(c, 'UTF8');
			i := i + 1;
		END IF;
	END LOOP;
	RETURN convert_from(bytes, 'UTF8');
EXCEPTION WHEN others THEN
	RETURN input;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- The name `notebookNameFromUrl` suggests for a page: the page name from the
-- last part of the path, like "Heat stress day 1", or the site when the path
-- has no name in it. `url` is already in `URL.href` form.
CREATE FUNCTION pg_temp.notebook_fallback_name(url text) RETURNS text AS $$
DECLARE
	host text;
	path text;
	segments text[];
	name text;
BEGIN
	host := regexp_replace(substring(url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/:?#]*)'), '^www\.', '');
	path := coalesce(substring(url from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*(/[^?#]*)'), '');
	segments := array_remove(string_to_array(path, '/'), '');
	WHILE coalesce(array_length(segments, 1), 0) > 1
		AND lower(segments[array_length(segments, 1)]) IN ('edit', 'view', 'preview') LOOP
		segments := segments[1:array_length(segments, 1) - 1];
	END LOOP;
	IF coalesce(array_length(segments, 1), 0) = 0 THEN
		RETURN host;
	END IF;
	name := pg_temp.notebook_url_decode(segments[array_length(segments, 1)]);
	name := regexp_replace(name, '[-_]?([0-9a-fA-F]{16,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$', '');
	name := btrim(regexp_replace(name, '[-_]+', ' ', 'g'));
	IF name = '' THEN
		RETURN host;
	END IF;
	RETURN name;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
INSERT INTO "notebooks" (
	"url", "url_key", "name", "owner_id",
	"created_at", "created_by", "created_by_token",
	"updated_at", "updated_by", "updated_by_token"
)
WITH "newest" AS (
	SELECT DISTINCT ON ("url_key") "url_key", "url"
	FROM "run_notebook_links"
	ORDER BY "url_key", "created_at" DESC, "id" DESC
), "earliest" AS (
	SELECT DISTINCT ON ("url_key") "url_key", "created_at", "created_by", "created_by_token"
	FROM "run_notebook_links"
	ORDER BY "url_key", "created_at", "id"
), "last_changed" AS (
	SELECT DISTINCT ON ("url_key") "url_key", "updated_at", "updated_by", "updated_by_token"
	FROM "run_notebook_links"
	ORDER BY "url_key", "updated_at" DESC, "id" DESC
), "top_label" AS (
	SELECT DISTINCT ON ("url_key") "url_key", "label"
	FROM (
		SELECT "url_key", btrim("label") AS "label", count(*) AS "uses", max("created_at") AS "newest"
		FROM "run_notebook_links"
		WHERE "label" IS NOT NULL AND btrim("label") <> ''
		GROUP BY "url_key", btrim("label")
	) AS "labels"
	ORDER BY "url_key", "uses" DESC, "newest" DESC, "label"
), "top_owner" AS (
	SELECT DISTINCT ON ("url_key") "url_key", "user_id"
	FROM (
		SELECT
			"link"."url_key",
			"attribution"."user_id",
			count(DISTINCT "run"."id") AS "runs",
			max(coalesce("run"."acquired_at", "run"."created_at")) AS "latest"
		FROM "run_notebook_links" AS "link"
		JOIN "instrument_runs" AS "run" ON "run"."id" = "link"."run_id" AND "run"."deleted_at" IS NULL
		JOIN "run_attributions" AS "attribution" ON "attribution"."run_id" = "run"."id"
		GROUP BY "link"."url_key", "attribution"."user_id"
	) AS "owners"
	ORDER BY "url_key", "runs" DESC, "latest" DESC, "user_id"
)
SELECT
	"newest"."url",
	"newest"."url_key",
	coalesce("top_label"."label", pg_temp.notebook_fallback_name("newest"."url")),
	"top_owner"."user_id",
	"earliest"."created_at",
	"earliest"."created_by",
	"earliest"."created_by_token",
	"last_changed"."updated_at",
	"last_changed"."updated_by",
	"last_changed"."updated_by_token"
FROM "newest"
JOIN "earliest" USING ("url_key")
JOIN "last_changed" USING ("url_key")
LEFT JOIN "top_label" USING ("url_key")
LEFT JOIN "top_owner" USING ("url_key");
--> statement-breakpoint
DROP FUNCTION pg_temp.notebook_fallback_name(text);--> statement-breakpoint
DROP FUNCTION pg_temp.notebook_url_decode(text);--> statement-breakpoint
ALTER TABLE "run_notebook_links" ADD COLUMN "notebook_id" uuid;--> statement-breakpoint
UPDATE "run_notebook_links" AS "link"
SET "notebook_id" = "notebook"."id"
FROM "notebooks" AS "notebook"
WHERE "notebook"."url_key" = "link"."url_key";--> statement-breakpoint
ALTER TABLE "run_notebook_links" ALTER COLUMN "notebook_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "run_notebook_links" ADD CONSTRAINT "run_notebook_links_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_notebook_links_notebook_id" ON "run_notebook_links" USING btree ("notebook_id");--> statement-breakpoint
ALTER TABLE "run_notebook_links" ADD CONSTRAINT "uq_run_notebook_links_run_id_notebook_id" UNIQUE("run_id","notebook_id");--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP CONSTRAINT "uq_run_notebook_links_run_id_url_key";--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP CONSTRAINT "run_notebook_links_one_updater";--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP CONSTRAINT "run_notebook_links_updated_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP CONSTRAINT "run_notebook_links_updated_by_token_personal_access_tokens_id_fk";--> statement-breakpoint
DROP INDEX "idx_run_notebook_links_url_key_trgm";--> statement-breakpoint
DROP INDEX "idx_run_notebook_links_url_trgm";--> statement-breakpoint
DROP INDEX "idx_run_notebook_links_label_trgm";--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP COLUMN "url";--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP COLUMN "url_key";--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP COLUMN "label";--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP COLUMN "updated_by";--> statement-breakpoint
ALTER TABLE "run_notebook_links" DROP COLUMN "updated_by_token";--> statement-breakpoint
UPDATE "personal_access_tokens"
SET "scopes" = ARRAY(
	SELECT DISTINCT "scope"
	FROM unnest(array_replace("scopes", 'runs:link', 'notebooks:write')) AS "scope"
	ORDER BY "scope"
)
WHERE 'runs:link' = ANY("scopes");
