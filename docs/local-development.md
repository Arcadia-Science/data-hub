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

Sign in at `/login` using the "Sign in (dev)" button with the seeded `dev@local` email — no password, no Google Workspace.

## Prerequisites

- **PostgreSQL >= 15** running locally on `127.0.0.1:5432` and reachable as the OS user.
- **Node.js >= 22**.

Python, AWS CLI, Docker, and SAM are not required for this workflow.

## Minimal `.env`

Create `web/.env` with the following. The first two are mandatory; the rest are dummy values that let signed-URL generation and IAM-flagged code paths run without hitting AWS.

```sh
DATABASE_URL=postgres://localhost:5432/data-hub-local

# Any 32+ character string. NextAuth uses it to sign session JWTs.
AUTH_SECRET=local-dev-secret-at-least-32-characters!!

# Dummy AWS credentials. The AWS SDK signs presigned URLs locally
# (HMAC-only — no network call), so any non-empty values work. Actual
# uploads/downloads against `test-raw-data-bucket` will fail at the
# browser, which is fine for local dev (see "What's deliberately
# missing" below).
AWS_ACCESS_KEY_ID=test-key
AWS_SECRET_ACCESS_KEY=test-secret
AWS_REGION=us-east-1
S3_RAW_DATA_BUCKET=test-raw-data-bucket
```

Explicitly **do not** set the following — leaving them unset is what makes the relevant features short-circuit cleanly:

- `LAMBDA_FUNCTION_URL` — file reprocessing and "Download all" buttons surface a 503 / "Lambda not configured" message instead of trying to invoke a Function URL.
- `SLACK_WEBHOOK_URL` — `sendSlackMessage()` in `web/lib/slack.ts` becomes a no-op with a single warn line.
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — Google sign-in is unused locally; the dev Credentials provider handles auth.
- `AWS_ROLE_ARN` — Vercel OIDC federation is for production. The local AWS SDK falls back to the static credentials above.

## Sign in (dev only)

`web/lib/auth.ts` registers a `Credentials` provider with id `"dev"` when `process.env.NODE_ENV !== "production"`. The `/login` page renders a matching "Sign in (dev)" form under the Google button. The form accepts any email present in the `user` table and mints a session via the existing JWT strategy — `users.is_admin` is read on sign-in just like for Google sign-ins, so the seeded `dev@local` lands as a workspace admin.

The dev provider is **not** instantiated in production builds. The form is also conditionally rendered server-side, so a production `npm run build` never ships the affordance.

To sign in as a non-admin user instead, seed an extra row manually (or edit `web/scripts/seed-database.ts`) and enter their email in the form.

## Using the seeded PAT

The seed script prints a personal access token after it finishes:

```
Or call the API with the seeded PAT:
  curl -H 'Authorization: Bearer dhub_<long-hex>' \
    http://localhost:3000/api/v1/instruments
```

The token carries the `*` (wildcard) scope so every v1 endpoint accepts it. Useful for poking at the REST API, the MCP server (`/api/v1/mcp`), or wiring up an external tool while you iterate.

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
| `user` | 1 | `dev@local`, `is_admin = true` |
| `personal_access_tokens` | 1 | Wildcard scope, no expiry |
| `instruments` | 8 (one per `instrument_type`) | First row is `pending`; rest `active` |
| `watchers` | 7 (for active instruments) | Rotates through `watching` / `registered` / `stopped` |
| `watcher_heartbeats` | ~10 per watching watcher | Spread over the last hour |
| `watcher_events` | 3 per watching watcher | `watcher_started`, `config_synced`, `file_uploaded` |
| `instrument_runs` | 5 per active instrument | Spread across the last ~2 weeks (3, 6, 9, 12, 15 days back), alternating `lambda` / `watcher` source |
| `files` | 3 per run | Mix of `uploaded` / `completed` / `failed`, `raw` / `processed` |
| `run_comments` | 1 per run | Authored by the dev user |
| `run_attributions` | 1 per run | Dev user attributed |
| `archive_jobs` | 3 | One each of `ready` / `building` / `failed` |
| `watcher_release_config` | 1 (singleton) | `9.9.9 / 0.1.0 / stable / false` |

Externally-visible identifiers used in URLs and API paths — instrument IDs (`seed-<type>`) and run IDs (`seed-run-1`, …) — are deterministic across reseeds, so screenshots, bug reports, and `curl` examples against `/api/v1/instruments/seed-plate-reader/runs/seed-run-1` stay stable.

Surrogate UUIDs (watcher IDs, archive job IDs, the per-row primary keys on `instrument_runs` and `files`) and the PAT plaintext are regenerated on every reseed — the seed does not use Faker but it does call `crypto.randomUUID()` and `crypto.randomBytes()` where the schema needs server-side IDs.

## What's deliberately missing

Some features depend on services that aren't running in this workflow. Each one degrades cleanly rather than crashing the dashboard:

| Feature | Behavior locally | How to enable |
| --- | --- | --- |
| File download | Presigned URL renders but GET fails — no real S3 object | Point S3 env vars at a real bucket or LocalStack/MinIO |
| File upload (from watcher) | `request-upload-url` returns a usable signed URL, but actually PUTting fails | Same |
| Run archive ("Download all") | 503 "Archive builder is not configured" | Set `LAMBDA_FUNCTION_URL` + `S3_ARCHIVES_BUCKET` and grant `lambda:InvokeFunctionUrl` |
| File reprocessing | The reprocess endpoint returns null and no Lambda is invoked | Same |
| Slack notifications on new runs | `console.warn` only, no HTTP call | Set `SLACK_WEBHOOK_URL` |
| Watcher uploads → Lambda → API loop | Not exercised; the seed inserts the resulting rows directly | Run the watcher (`docs/watcher.md`) and the Lambda (`docs/lambda.md`) end-to-end |
| Sign in with Google | The button still renders but OAuth callback will 4xx without `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | `vercel env pull` per `docs/getting-started.md` |

## Where the seed lives

- [web/lib/db/seed.ts](../web/lib/db/seed.ts) — shared builder functions (`seedDevUser`, `seedInstruments`, `seedRuns`, etc.) plus a schema-driven `clearAll()`.
- [web/scripts/seed-database.ts](../web/scripts/seed-database.ts) — the entry point that `npm run db:seed` runs.

The same builders back the integration test harness in [web/tests/integration/helpers.ts](../web/tests/integration/helpers.ts), so any new table added to `web/lib/db/schema.ts` is automatically included in `clearAll()` and only needs a new builder function if you want it populated by the dev seed.

## Cross-links

- [Getting started](getting-started.md) — full setup with real Google OAuth and AWS credentials.
- [Architecture](architecture.md) — system overview and data flow.
- [REST API](api.md) — endpoint reference for the seeded PAT.
- [MCP server](mcp.md) — Model Context Protocol tools at `/api/v1/mcp`.
