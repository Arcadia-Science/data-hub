# Getting started

This guide walks through setting up the full Data Hub development environment.

## Prerequisites

| Tool | Version | Purpose |
| --- | --- | --- |
| Python | >= 3.12 | Lambda, watcher, shared library |
| [uv](https://docs.astral.sh/uv/) | latest | Python package manager and workspace orchestrator |
| Node.js | >= 22 | Web application |
| PostgreSQL | >= 15 | Database (local development) |
| Docker | latest | Lambda container builds |
| [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) | latest | Infrastructure deployment (optional — only needed for deploying to AWS) |

## Clone and install

```sh
git clone <repo-url>
cd data-hub

# Install all Python packages across the workspace.
uv sync --all-packages

# Install web app dependencies.
cd web && npm install && cd ..
```

The Python workspace is managed by uv. The root `pyproject.toml` defines three workspace members — `lambda`, `watcher`, and `packages/shared` — and all are installed together by `uv sync --all-packages`.

## Environment variables

### Web application

The web app requires the following variables. The easiest way to get them is via the Vercel CLI:

```sh
cd web
vercel env pull
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `AUTH_GOOGLE_ID` | Yes | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Yes | Google OAuth client secret |
| `AUTH_SECRET` | Yes | NextAuth session encryption key |
| `AWS_REGION` | No | AWS region for S3 presigned URLs and Lambda Function URL SigV4 signing (defaults to `us-west-1`) |
| `AWS_ROLE_ARN` | No | IAM role ARN for Vercel OIDC federation. Used to presign S3 URLs and SigV4-sign Lambda Function URL invocations (only needed on Vercel) |
| `S3_RAW_DATA_BUCKET` | No | S3 bucket for raw data uploads (defaults to `arcadia-data-hub-raw-staging`) |
| `LAMBDA_FUNCTION_URL` | No | Lambda Function URL. Required for file reprocessing and run-archive downloads. |
| `SLACK_BOT_TOKEN` | No | Slack bot token (`xoxb-…`) — required for personal Slack DM notifications |
| `SLACK_CLIENT_ID` | No | Slack app client ID — required for the "Connect to Slack" OAuth flow on Settings > Notifications |
| `SLACK_CLIENT_SECRET` | No | Slack app client secret — required for the OAuth flow |
| `SLACK_STATE_SECRET` | No | Signing secret for OAuth state tokens; falls back to `AUTH_SECRET` |
| `SLACK_REDIRECT_URI` | No | Override the OAuth redirect URI (defaults to `<origin>/api/v1/settings/slack/callback`) |
| `SLACK_TEAM_ID` | No | Restrict Slack connections to a specific workspace ID (recommended for single-tenant deployments) |

> **Local dev note:** the Lambda Function URL is configured with `AuthType: AWS_IAM`, so to invoke it from `make dev` you need AWS credentials with `lambda:InvokeFunctionUrl` on the staging function ARN. The default credential chain (`aws sso login`, `~/.aws/credentials`, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) is used when `AWS_ROLE_ARN` is unset locally.

### Lambda / shared library

These are set in the Lambda runtime environment:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AWS_REGION` | No | AWS region (defaults to `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | No | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | No | AWS credentials |
| `AWS_S3_RAW_DATA_BUCKET` | No | S3 bucket for raw data |
| `AWS_S3_PROCESSED_DATA_BUCKET` | No | S3 bucket for processed data |

### Watcher

The watcher reads its configuration from a YAML file at `~/.data-hub/config.yaml`. See the [watcher docs](reference/watcher.md) for details. The only environment variable it uses is `DATA_HUB_API_KEY` (optional, can also be provided interactively during `init`).

## Database setup

```sh
cd web

# Create a local PostgreSQL database.
createdb data-hub-local

# Push the Drizzle schema (no migration files generated).
npm run db:push
```

Other database commands:

| Command | Description |
| --- | --- |
| `npm run db:generate` | Generate Drizzle migration files |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:push` | Push schema directly (no migration files) |
| `npm run db:studio` | Open Drizzle Studio GUI |
| `npm run db:reset` | Drop and re-create the public schema |
| `npm run db:seed` | Load a deterministic seed (see [Local development](local-development.md)) |
| `npm run db:reseed` | `db:reset` + `db:push` + `db:seed` in one shot |

> **Web + API + database only?** If you don't need the watcher or Lambda, see [Local development](local-development.md) for a zero-credential setup using `make db-reseed` and a dev-only sign-in.

## Running locally

```sh
# Start the web app dev server (Turbopack).
make dev

# Or equivalently:
cd web && npm run dev
```

The app runs at [http://localhost:3000](http://localhost:3000).

## Running checks

Before pushing, run the full formatting, lint, and type-check suite:

```sh
make check-all
```

This runs both Python and web app checks:

| Target | What it does |
| --- | --- |
| `make py-format` | Auto-fix with Ruff |
| `make py-lint` | Ruff linter |
| `make py-typecheck` | Pyright |
| `make fe-format` | Biome format + safe lint fixes (`ultracite fix`) |
| `make fe-lint` | Biome format + lint check (`ultracite check`) |
| `make fe-typecheck` | TypeScript compiler |

## Running tests

```sh
# Python unit tests only.
make py-test-unit

# Python integration tests (requires Postgres + builds/starts Next.js).
make py-test-integration

# All Python tests.
make py-test

# Web app API integration tests (requires Postgres + builds/starts Next.js).
make fe-test-integration
```

Integration tests use a `data_hub_test` Postgres database and spin up a real Next.js production server. See [CI and deployment](ops/ci-and-deployment.md) for how these run in GitHub Actions.
