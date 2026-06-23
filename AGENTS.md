# AGENTS.md

## Cursor Cloud specific instructions

Data Hub is a multi-component repo (see `README.md`). The component you can run end-to-end
locally with zero external credentials is the **Next.js web app + REST API + PostgreSQL**
(`web/`). The `lambda/`, `watcher/`, and `packages/shared/` Python packages are exercised
via tests and a local S3 mirror — no real AWS is needed for local work.

Standard commands live in the `Makefile`, `web/package.json`, `docs/getting-started.md`, and
`docs/local-development.md`. The notes below are the non-obvious caveats that those docs don't
make obvious for a fresh cloud VM (where the update script has already installed deps).

### Starting services (not handled by the update script)

- **PostgreSQL must be started on every fresh VM** — the cluster is installed and the data
  (roles + databases) persist in the snapshot, but the server process is not running at boot:
  `sudo pg_ctlcluster 16 main start` (or `sudo service postgresql start`).
- Postgres is reachable at `postgres://postgres:postgres@127.0.0.1:5432`. Databases
  `data-hub-local` (dev) and `data_hub_test` (integration tests) already exist. The integration
  harness (`web/tests/integration/global-setup.ts`) hardcodes these same credentials and creates
  `data_hub_test` itself if missing.
- **Web dev server:** `make dev` (Next.js + Turbopack on http://localhost:3000). Sign in at
  `/login` with the "Sign in (dev)" button using email `dev@local` (workspace admin; no password).

### Environment file

`web/.env` is gitignored and required for `make dev` / seeding. If it is missing on a fresh VM,
recreate it from the "Minimal `.env`" block in `docs/local-development.md` (the key lines are
`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/data-hub-local`, a 32+ char
`AUTH_SECRET`, dummy `AWS_*` values, and `LOCAL_S3_MIRROR=../lambda/.local-s3`).

### Node / Python toolchain

- Use **Node 24 (npm 11)** — it is the nvm default and is what CI uses. `npm ci` against the
  committed `web/package-lock.json` **fails under npm 10** ("Missing: esbuild@… from lock file"),
  so don't downgrade. A clean login shell already selects Node 24 via nvm.
- Python is managed by `uv` (Python 3.13, pinned in `.python-version`). Run Python tools through
  `uv run …` (e.g. `uv run pytest`); the Makefile targets already do this.

### Seeding and local file bytes

- `make db-reseed` resets + pushes the Drizzle schema + seeds deterministic data. It prints a
  personal access token (`dhub_…`) for the dev user — use it for `Authorization: Bearer` API calls.
- The seed's fixture-processing step is **skipped if the dev server isn't running** (it prints a
  hint). To populate processed artifacts (gel-doc PNGs, plate-reader CSVs, qPCR metadata), start
  `make dev` first, then run `npm run db:process-fixtures` from `web/`.

### Testing caveat

- `make fe-test-integration` and `make py-test-integration` run `next build` + `next start`, which
  writes to `web/.next` and **contends with a running `make dev`** (also using `.next`). Stop the
  dev server before running integration tests, then restart it afterward.
- Lint/format/typecheck: `make check-all` (note: `py-format`/`fe-format` auto-rewrite files; use
  `uv run ruff check .`, `npm run lint:check` (Biome formatter + linter, read-only), and
  `npm run typecheck` for read-only checks).
