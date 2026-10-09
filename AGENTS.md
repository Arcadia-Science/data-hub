# AGENTS.md

## Commits and pull requests

Do **not** put sensitive information from internal environments (production, staging, or a coworker's machine) into commit messages, PR titles/bodies, review comments, or committed files. That includes:

- Credentials and secrets: PATs (`dhub_…`), `AUTH_SECRET`, AWS keys/session tokens, database passwords, webhook secrets
- Pre-signed or authenticated URLs (S3 download links, anything with `X-Amz-Security-Token` / signature query params)
- Identifiers from internal environments: instrument IDs, run IDs, file IDs, and real filenames from those runs
- Raw dumps from internal MCP tools, API responses, or logs that embed the above
- `.env` contents or other gitignored config copied into the diff

Safe to reference: public docs URLs, redacted error messages, and synthetic fixtures. When a PR needs to describe a production incident, summarize the failure mode — don't paste tokens, signed URLs, IDs, or full internal payloads.

## Documentation

Documentation lives in `docs/`, split by who is reading:

- `docs/site/` is the public docs site (Fumadocs on Next.js) at https://datahub.arcadiascience.com/docs. It covers installing a watcher, setting up an instrument, managing tokens, security and permissions, and the API, MCP, and watcher CLI reference. Pages are MDX files in `docs/site/content/docs/`. Read `docs/site/AGENTS.md` before editing it. For "how do I use Data Hub" questions, search the published site first and don't rely on training data or guess at UI flows: its `/docs/llms.txt` and `/docs/llms-full.txt` routes (and a `.md` suffix on any page URL) serve clean Markdown that's cheap to fetch.
- `docs/developer/` covers contributing to and self-hosting Data Hub itself: architecture internals, local dev setup (`getting-started.md`, `local-development.md`), conventions, the step-by-step self-hosting guide for the web app and AWS infrastructure (`first-time-deployment.md`) plus CI/ongoing-deploy reference (`ci-and-deployment.md`), and per-package references (`lambda.md`, `watcher.md`, `shared-library.md`). These are plain Markdown read on GitHub. The docs site does not render them. See `docs/developer/README.md` for the full index.

The docs site deploys from the `production` branch, so a docs change goes live when `staging` is promoted, together with the feature it describes. Change the docs in the same branch as the feature.

### Watcher version

Shipped watcher changes (`watcher/src/`) need a version bump in the same branch. Follow `watcher/AGENTS.md`: bump `[project].version` in `watcher/pyproject.toml` once if it still matches the merge-base, then run `uv lock`, then run `make py-watcher-cli-catalog` and commit the updated `docs/site/src/lib/cli-catalog.snapshot.json`, which records the version. Do not tag the release from the feature branch.

### Changelog

User-visible changes need a dated entry in `web/content/changelog/` in the same branch. That includes the web app, file processing, the API, and AI assistant behavior.

Name the file `YYYY-MM-DD-short-slug.md`. The date is the day the pull request merges into `staging`. The slug is lowercase words separated by hyphens. The file starts with YAML frontmatter (`title`, and `docs` when a docs page explains the change) and a short markdown body. If the change needs a new watcher version, the entry names that version. Watcher versions do not get their own entries.

Do not add an entry for tests, docs, CI, dependency updates, or infrastructure.

### Reference snapshots (docs site)

The API, MCP, and [Watcher CLI](https://datahub.arcadiascience.com/docs/cli-reference) pages on the docs site render from three JSON files committed in `docs/site/src/lib/`: `openapi.snapshot.json`, `mcp-catalog.snapshot.json`, and `cli-catalog.snapshot.json`. They are generated from the code and never edited by hand.

1. Change the REST API (`web/lib/api/openapi/`), the MCP tools, prompts, or resources (`web/lib/mcp/`), or the watcher CLI help or options (`watcher/src/data_hub_watcher/cli.py`).
2. Run `make docs-catalogs`. To refresh only the watcher CLI file, run `make py-watcher-cli-catalog`.
3. Commit the changed snapshot files in the same branch.

CI regenerates each file and fails when the committed copy differs.

## Cursor Cloud specific instructions

Data Hub is a multi-component repo (see `README.md`). The component you can run end-to-end locally with zero external credentials is the **Next.js web app + REST API + PostgreSQL** (`web/`). The `lambda/`, `watcher/`, and `packages/shared/` Python packages are exercised via tests and a local S3 mirror — no real AWS is needed for local work.

Standard commands live in the `Makefile`, `web/package.json`, `docs/developer/getting-started.md`, and `docs/developer/local-development.md`. The notes below are the non-obvious caveats that those docs don't make obvious for a fresh cloud VM (where the update script has already installed deps).

### Starting services (not handled by the update script)

- **PostgreSQL must be started on every fresh VM** — the cluster is installed and the data (roles + databases) persist in the snapshot, but the server process is not running at boot: `sudo pg_ctlcluster 16 main start` (or `sudo service postgresql start`).
- Postgres is reachable at `postgres://postgres:postgres@127.0.0.1:5432`. Databases `data-hub-local` (dev) and `data_hub_test` (integration tests) already exist. The integration harness (`web/tests/integration/global-setup.ts`) hardcodes these same credentials and creates `data_hub_test` itself if missing.
- **Web dev server:** `make dev` (Next.js + Turbopack on http://localhost:3000). Sign in at `/login` with the "Sign in (dev)" button using email `alice@example.com` (workspace admin; shared seed password is submitted invisibly).

### Environment file

`web/.env` is gitignored and required for `make dev` / seeding. If it is missing on a fresh VM, recreate it from the "Minimal `.env`" block in `docs/developer/local-development.md` (the key lines are `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/data-hub-local`, a 32+ char `AUTH_SECRET`, `BETTER_AUTH_URL=http://localhost:3000`, dummy `AWS_*` values, and `LOCAL_S3_MIRROR=../lambda/.local-s3`).

### Node / Python toolchain

- Use **Node 24 (npm 11)** — it is the nvm default and is what CI uses. `npm ci` against the committed `web/package-lock.json` **fails under npm 10** ("Missing: esbuild@… from lock file"), so don't downgrade. A clean login shell already selects Node 24 via nvm.
- Python is managed by `uv` (Python 3.13, pinned in `.python-version`). Run Python tools through `uv run …` (e.g. `uv run pytest`); the Makefile targets already do this.

### Seeding and local file bytes

- `make db-reseed` resets + pushes the Drizzle schema + seeds deterministic data. It prints a personal access token (`dhub_…`) for the dev user — use it for `Authorization: Bearer` API calls.
- The seed's fixture-processing step is **skipped if the dev server isn't running** (it prints a hint). To populate processed artifacts (gel-doc PNGs, plate-reader CSVs, qPCR metadata), start `make dev` first, then run `npm run db:process-fixtures` from `web/`.

### Testing caveat

- `make fe-test-integration` and `make py-test-integration` run `next build` + `next start`, which writes to `web/.next` and **contends with a running `make dev`** (also using `.next`). Stop the dev server before running integration tests, then restart it afterward.
- Lint/format/typecheck: `make check` (note: `py-format`/`fe-format`/`docs-format` auto-rewrite files; use `uv run ruff check .`, `npm run lint:check` (Biome formatter + linter, read-only), and `npm run typecheck` for read-only checks). `make check` also covers the docs site, which has its own dependencies: run `npm ci` in `docs/site/` first. `make docs-links` checks the links between the docs, the web app, and the changelog.
