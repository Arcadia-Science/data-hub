# Local development

A zero-credential workflow for iterating on the **web app + API + database** without standing up the watcher, Lambda, S3, Slack, or Google OAuth. Useful when you're working on UI, REST endpoints, MCP tools, or schema changes and don't care about the full ingestion pipeline.

For the full setup (Google OAuth, real AWS credentials, deployable artifacts) see [Getting started](getting-started.md).

## TL;DR

```sh
# 1. One-time: install dependencies and create the local Postgres database.
cd web && npm install && cd ..
createdb data-hub-local

# 2. Drop a minimal .env into web/ (see below).

# 3. Reset, push schema, seed.
make db-reseed

# 4. Start the dev server and open http://localhost:3000.
make dev
```

Sign in at `/login` using the "Sign in (dev)" button with the seeded `alice@example.com` email — the form submits a shared seed password invisibly; no Google Workspace needed.

## Prerequisites

- **PostgreSQL >= 15** running locally on `127.0.0.1:5432` and reachable as the OS user.
- **Node.js >= 22**.

Python, AWS CLI, Docker, and SAM are not required for this workflow.

## Minimal `.env`

Create `web/.env` with the following. The first two are mandatory; the rest are dummy values that let signed-URL generation and IAM-flagged code paths run without hitting AWS.

```sh
DATABASE_URL=postgres://localhost:5432/data-hub-local

# Any 32+ character string. Better Auth uses it to sign cookies / encrypt
# session data (also accepted as `BETTER_AUTH_SECRET`).
AUTH_SECRET=local-dev-secret-at-least-32-characters!!
# Public origin / OAuth issuer base (issuer = ${BETTER_AUTH_URL}/api/auth).
BETTER_AUTH_URL=http://localhost:3000

# Docs origin. Leave unset on Vercel, where Microfrontends serves /docs.
NEXT_PUBLIC_DOCS_BASE_URL=https://datahub.arcadiascience.com

# Dummy AWS credentials. The local-mirror branch in `web/lib/s3.ts`
# bypasses the AWS SDK entirely when LOCAL_S3_MIRROR is set, but a
# few server-side modules instantiate the SDK at import time so any
# non-empty values keep them happy.
AWS_ACCESS_KEY_ID=test-key
AWS_SECRET_ACCESS_KEY=test-secret
AWS_REGION=us-east-1
S3_RAW_DATA_BUCKET=test-raw-data-bucket

# Filesystem-backed S3 mirror. When set (and NODE_ENV != production),
# `web/lib/s3.ts` swaps presigned-URL generation, HEAD checks, and
# server-side stream reads for `<root>/<bucket>/<key>` lookups, and
# the seed copies fixture bytes into the mirror so seeded runs
# render real bytes. Path is resolved relative to web/. See
# "Working with file bytes locally" below.
LOCAL_S3_MIRROR=../lambda/.local-s3
```

Explicitly **do not** set the following — leaving them unset is what makes the relevant features short-circuit cleanly:

- `LAMBDA_FUNCTION_URL` — file reprocessing and "Download all" buttons surface a 503 / "Lambda not configured" message instead of trying to invoke a Function URL.
- `SLACK_BOT_TOKEN`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` — Slack DM/OAuth features are disabled when unset; the Settings > Notifications page renders a "Connect to Slack" button that is inert without these.
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — Google sign-in is unused locally; the non-production email/password path handles auth. Deployed environments need a real client, from [Create a Google OAuth client](first-time-deployment.md#create-a-google-oauth-client).
- `AWS_ROLE_ARN` — Vercel OIDC federation is for production. The local AWS SDK falls back to the static credentials above.

## Sign in (dev only)

`web/lib/auth.ts` enables Better Auth's `emailAndPassword` provider when `process.env.NODE_ENV !== "production"` (with sign-up disabled). The `/login` page renders a matching "Sign in (dev)" form under the Google button. The form accepts any seeded email and submits the shared seed password from `web/lib/dev-auth.ts` invisibly — `seedDevUser` / `seedTeammates` write a `credential` account row with that password hashed. `users.is_admin` is promoted from `ADMIN_EMAILS` on session create just like for Google sign-ins, so the seeded `alice@example.com` lands as a workspace admin.

Email/password is **not** enabled in production builds. The form is also conditionally rendered server-side, so a production `npm run build` never ships the affordance.

To sign in as a non-admin user instead, enter a seeded teammate email (Bob–Zoe) in the form.

## Using the seeded PAT

The seed script prints a personal access token after it finishes:

```
Or call the API with the seeded PAT:
  curl -H 'Authorization: Bearer dhub_<long-hex>' \
    http://localhost:3000/api/v1/instruments
```

The token carries the `*` (wildcard) scope so every v1 REST endpoint accepts it. Useful for curling the API or wiring up watchers/tools that still use PATs.

## Connecting an MCP client

MCP at `/mcp/v1` uses OAuth (not PATs by default). Point the client at `http://localhost:3000/mcp/v1` with `BETTER_AUTH_URL=http://localhost:3000`. Clients discover the authorization server via `/.well-known/oauth-protected-resource` (resource-specific: `…/mcp/v1`) and `/.well-known/oauth-authorization-server`. Sign in with the local "Sign in (dev)" flow when prompted (it resumes the OAuth authorize request); on the consent screen grant `read`, and `write` if the client needs mutating tools. Transport requires only `read`; mutating tools additionally require `write`.

For PAT-based MCP testing only (scripts, integration tests, quick Bearer curls), set `MCP_ALLOW_PAT_AUTH=true` in `web/.env` and restart `make dev`. That flag is hard-disabled on Vercel production and on self-hosted production (non-loopback `BETTER_AUTH_URL`). PAT fallback grants MCP `write` only for the `*` wildcard — fine-grained mutating PAT scopes stay read-only over MCP. Prefer OAuth for interactive clients (Cursor, Claude Desktop, etc.).

## Resetting

```sh
make db-reseed
```

This is `npm run db:reset && npm run db:push && npm run db:seed` under the hood:

| Command | What it does |
| --- | --- |
| `npm run db:reset` | `DROP SCHEMA public CASCADE; CREATE SCHEMA public` |
| `npm run db:push` | Re-apply the Drizzle schema in `web/lib/db/schema.ts` |
| `npm run db:seed` | Run `web/scripts/seed-database.ts` |

You can also run `npm run db:seed` on its own — it calls the schema-driven `clearAll()` first, so it's safe against an already-populated database.

## What the seed builds

| Entity | Count | Notes |
| --- | --- | --- |
| `user` | 26 | `alice@example.com` (admin) + Bob–Zoe teammates (`@example.com`) |
| `personal_access_tokens` | 1 | Wildcard scope, no expiry (Alice) |
| `instruments` | 11 | Production catalog (10 active) + 1 pending for the activate-instrument UI |
| `watchers` | 11 (one per instrument) | Prod-like hostnames; mix of `watching` / `registered` / `stopped` |
| `watcher_heartbeats` | ~10 per watching watcher | Spread over the last hour |
| `watcher_events` | 3 per watching watcher | `watcher_started`, `config_synced`, `file_uploaded` |
| `instrument_runs` | 8 per active instrument | Calendar-relative `acquired_at` (today, yesterday, this week, ~7d / ~10d / ~22d / earlier this month) so date-filter presets and today/this-week stats have distinct non-empty sets; alternating `lambda` / `watcher` source |
| `files` | 1–4 per run | Mix of `uploaded` / `completed` / `failed`. Fixture instruments (qPCR, gel doc, both SpectraMax readers) render the real fixture bytes in `LOCAL_S3_MIRROR`; other instruments use production-shaped synthetic filenames (see [Working with file bytes locally](#working-with-file-bytes-locally)) |
| `run_comments` | multi-author threads | Q&A / notes across Alice + teammates; richer threads on ~⅓ of runs |
| `run_attributions` | 1 per run | Rotated across Alice + teammates |
| `archive_jobs` | 3 | One each of `ready` / `building` / `failed` |
| `watcher_release_config` | 1 (singleton) | `1.0.0 / 0.1.0 / false` (matches seeded watcher version) |

Externally-visible identifiers used in URLs and API paths are deterministic across reseeds, so screenshots, bug reports, and `curl` examples stay stable. Instrument ids and display names mirror production (`agilent-4150-tapestation`, `instantraman`, `spectramax-id5-plate-reader`, …). Fixture-backed instruments keep realistic run ids (`Experiment_20260129`, `26.02.02_10.45.05`, `012926_AR_OD600`, …); other instruments use production-shaped synthetic run ids and filenames.

Surrogate UUIDs (watcher IDs, archive job IDs, the per-row primary keys on `instrument_runs` and `files`) and the PAT plaintext are regenerated on every reseed — the seed does not use Faker but it does call `crypto.randomUUID()` and `crypto.randomBytes()` where the schema needs server-side IDs.

## What's deliberately missing

Some features depend on services that aren't running in this workflow. Each one degrades cleanly rather than crashing the dashboard:

| Feature | Behavior locally | How to enable |
| --- | --- | --- |
| File download | Served from `LOCAL_S3_MIRROR` if set (real bytes for seeded qPCR / gel doc / plate reader runs out of the box; other instruments staged via `data-hub-process handler`). 404s when unset. See [Working with file bytes locally](#working-with-file-bytes-locally) | Point S3 env vars at a real bucket or LocalStack/MinIO |
| File upload (from watcher) | `request-upload-url` returns a same-origin URL routed to `/api/local-s3/...`; `PUT` writes bytes into the mirror | Same |
| Run archive ("Download all") | 503 "Archive builder is not configured" | Set `LAMBDA_FUNCTION_URL` + `S3_ARCHIVES_BUCKET` and grant `lambda:InvokeFunctionUrl` |
| File reprocessing | The reprocess endpoint returns null and no Lambda is invoked | Same |
| Slack channel notifications on new runs | `console.warn` only, no HTTP call | Configure an incoming webhook URL in Settings > Notifications > Slack channel (admins only) |
| Slack DM notifications / Connect to Slack | `console.warn` only; the "Connect to Slack" button redirects to Slack but the callback will error without credentials | Set `SLACK_BOT_TOKEN`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` |
| Watcher uploads → Lambda → API loop | Not exercised end-to-end; the seed inserts the resulting rows directly. For Lambda-only smoke testing, see [Testing the Lambda end-to-end](#testing-the-lambda-end-to-end) below | Run the watcher (`watcher.md`) and the Lambda (`lambda.md`) end-to-end |
| Sign in with Google | The button still renders but OAuth callback will 4xx without `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | `vercel env pull` per `getting-started.md` |

## Testing the Lambda end-to-end

Working on a `process_file()` module (or wiring up a brand new one — see [Lambda → Adding a new instrument](lambda.md#adding-a-new-instrument)) and want to run it against the local web app without standing up real S3? The lambda CLI ships a `handler` subcommand that drives `lambda_handler` end-to-end against a gitignored directory mirroring the S3 layout.

```sh
cd lambda

# Point the inner DataHubClient at the local dev API. The PAT is printed
# by `npm run db:seed` / `make db-reseed`.
export DATA_HUB_API_URL=http://localhost:3000/api/v1
export DATA_HUB_API_KEY=dhub_<paste-from-seed-output>

# instrument_id / run_id / filename match the kebab-case S3 key layout the
# real Lambda expects; --source is the local file you want "uploaded".
uv run data-hub-process handler \
  agilent-4150-tapestation \
  run-1 \
  sample.csv \
  --source ~/Downloads/sample.csv
```

What happens under the hood:

1. The CLI copies `--source` into `lambda/.local-s3/test-raw-data-bucket/<instrument-id>/<run-id>/<filename>`. That mirror directory is gitignored.
2. `AWS_S3_RAW_DATA_BUCKET` / `AWS_S3_PROCESSED_DATA_BUCKET` are set so `process_file()` modules see consistent bucket names.
3. `data_hub_shared.s3_utils.download_file` and `upload_file` are monkey-patched for the duration of the call to `shutil.copy2` from/to the mirror — no boto3, no AWS credentials, no LocalStack.
4. A synthetic S3 event is built and `lambda_handler(event, ctx)` runs the same dispatch path production uses, calling the dev API at `localhost:3000` for the run/file upserts.

After it returns, navigate to `http://localhost:3000/instruments/<instrument-id>/runs/<run-id>` to inspect what landed; processed artifacts show up under `lambda/.local-s3/test-processed-data-bucket/...`.

Useful flags (`uv run data-hub-process handler --help` for the full list):

| Flag | Default | Purpose |
| --- | --- | --- |
| `--source FILE` | required | Local file to stage as the "uploaded" raw object. |
| `--mirror-root DIR` | `<repo>/lambda/.local-s3` (or `$LOCAL_S3_MIRROR`) | Where the mirror lives on disk. |
| `--raw-bucket NAME` | `test-raw-data-bucket` | First path segment under the mirror for the raw file. |
| `--processed-bucket NAME` | `test-processed-data-bucket` | First path segment for `upload_file` calls from the processor. |

The wiring lives in [lambda/src/data_hub_lambda/cli.py](../lambda/src/data_hub_lambda/cli.py) (`handler` subcommand) and [lambda/src/data_hub_lambda/local_s3_mirror.py](../lambda/src/data_hub_lambda/local_s3_mirror.py) (`patched_s3` context manager). The same patch surface backs the integration suite at [lambda/tests/integration/conftest.py](../lambda/tests/integration/conftest.py), so anything that works under the CLI is exercised in CI too.

## Working with file bytes locally

`LOCAL_S3_MIRROR` makes the Next.js app share the same on-disk layout the lambda CLI writes to. When it's set (and `NODE_ENV != production`), the four helpers in [web/lib/s3.ts](../web/lib/s3.ts) — `getPresignedDownloadUrl`, `getPresignedUploadUrl`, `headS3Object`, `getS3ObjectStream` — short-circuit AWS and serve from disk. The HTTP face of the mirror is a single dev-only catch-all at [web/app/api/local-s3/[bucket]/[...key]/route.ts](../web/app/api/local-s3/%5Bbucket%5D/%5B...key%5D/route.ts) that handles GET (download with optional `Content-Disposition`) and PUT (writes bytes from the request body). Note the folder is `local-s3` (no leading underscore) — the App Router treats `_`-prefixed folders as private and excludes them from routing.

What this gets you out of the box after `make db-reseed`:

| Instrument type | Seeded fixtures (cycled across runs) | Where they come from |
| --- | --- | --- |
| qPCR | `azure_cielo_qpcr_example.csv` | `lambda/tests/fixtures/` |
| Gel doc | `azure_600_gel_doc_{example,fluorescence,true_color}.tif` | `lambda/tests/fixtures/` |
| Plate reader (iD3 + iD5) | `spectramax_plate_reader_{endpoint,endpoint_flat,endpoint_sparse,fluorescence,kinetic,well_scan,luminescence}.xls`; Spectrum is `spectrum.xls` (96-well, iD5) and `spectrum_384.xls` (384-well + Endpoint, iD3) | `lambda/tests/fixtures/` |
| Other instruments | none — files 404 in the mirror | Stage real bytes via `data-hub-process handler` |

The seed cycles every available fixture for an instrument across its seeded runs (so gel-doc screenshots include Chemiluminescence, Fluorescence, and True Color Imaging, not eight copies of the same chemi TIFF). Each run gets one fixture copied to `<LOCAL_S3_MIRROR>/test-raw-data-bucket/<instrument-id>/<run-id>/<filename>`, so navigating to `/instruments/azure-cielo-qpcr/runs/Experiment_20260129` shows a real CSV in the file browser, the colony / plate-reader viewers fetch real bytes via `/api/v1/files/<id>/download`, and PNG / TIFF / PDF previews on `RunReportSection` render without 404s. Fixture-bearing runs only have the real fixture file — the synthetic CSV siblings other instruments still get are dropped so the UI only shows files that actually exist on disk.

When the dev API is reachable during seeding, the seed also drives `data-hub-process handler` over each fixture-bearing run so the dashboard renders processed artifacts (gel-doc PNGs, plate-reader CSVs, qPCR metadata) immediately after a reseed. If the API isn't up yet (`npm run db:reseed` ran before `npm run dev`), the seed prints a hint and skips the step — you can re-run it on its own once the dev server is reachable:

```sh
# in the terminal where the dev server is running
npm run dev
# in another terminal, after the dev server is reachable
npm run db:process-fixtures
```

`npm run db:process-fixtures` mints a fresh PAT for `alice@example.com`, re-derives the fixture-bearing `(instrument_id, run_id, filename)` triples from the database, and spawns `data-hub-process handler` for each. The wiring lives in [web/scripts/process-fixtures.ts](../web/scripts/process-fixtures.ts) — it's the same module the seed calls — so anything that works during a reseed also works post-hoc.

For instrument types without a fixture (or new file types you're adding components for), the existing CLI flow stays the same: run `data-hub-process handler <instrument-id> <run-id> <filename> --source <FILE>` and the dashboard picks up the file the moment the API row lands.

Components don't need to change — every existing run viewer already fetches `/api/v1/files/<id>/download`, which 302s to whatever `getPresignedDownloadUrl` returns. New custom components for a specific instrument should follow the same pattern (`fetch("/api/v1/files/<id>/download")` for raw bytes, `<img src="/api/v1/files/<id>/download">` for images) and inherit local-mirror support automatically.

A few details worth knowing:

- Adding fixtures for more instruments means an `INSTRUMENT_FIXTURES` entry in [web/lib/db/seed.ts](../web/lib/db/seed.ts) keyed by the kebab-case instrument id from `data_hub_shared.enums.Instrument` (`{ files: [{ filename, contentType }, …], runIds }`) pointing at files under `lambda/tests/fixtures/`. List every fixture you want cycled across seeded runs. The handler rejects unknown instrument ids because `parse_s3_event` only accepts values from that enum.
- The route is gated on `NODE_ENV !== "production"` AND `LOCAL_S3_MIRROR` set; either condition unmet returns 404 unconditionally, so a production build can never expose the filesystem.
- The MCP tool at `/mcp/v1` returns a relative `/api/local-s3/...` URL when the mirror is active — browsers resolve it against the current origin, but non-browser MCP clients on localhost may need to prefix with `http://localhost:3000`.

## Where the seed lives

- [web/lib/db/seed.ts](../web/lib/db/seed.ts) — shared builder functions (`seedDevUser`, `seedInstruments`, `seedRuns`, etc.) plus a schema-driven `clearAll()`.
- [web/scripts/seed-database.ts](../web/scripts/seed-database.ts) — the entry point that `npm run db:seed` runs.
- [web/scripts/process-fixtures.ts](../web/scripts/process-fixtures.ts) — shared probe/spawn logic for the post-seed handler step.
- [web/scripts/process-seeded-fixtures.ts](../web/scripts/process-seeded-fixtures.ts) — `npm run db:process-fixtures` entry point for re-running the handler step on demand.

The same builders back the integration test harness in [web/tests/integration/helpers.ts](../web/tests/integration/helpers.ts), so any new table added to `web/lib/db/schema.ts` is automatically included in `clearAll()` and only needs a new builder function if you want it populated by the dev seed.

## Cross-links

- [Getting started](getting-started.md) — full setup with real Google OAuth and AWS credentials.
- [Architecture](architecture.md) — system overview and data flow.
- [REST API](https://datahub.arcadiascience.com/docs/api) — on-ramp and generated endpoints for the seeded PAT.
- [MCP](https://datahub.arcadiascience.com/docs/mcp) — Model Context Protocol tools at `/mcp/v1`.
