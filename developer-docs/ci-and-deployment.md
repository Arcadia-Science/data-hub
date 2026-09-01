# CI and deployment

## GitHub Actions

Four workflows run on pushes to `staging`/`production` and on pull requests targeting those branches. A fifth (`apply-migrations.yml`) runs on merges to `staging`/`production` that touch migration files, and a sixth (`publish-watcher.yml`) runs only on `watcher-v*` tag pushes and manual dispatch.

### Python lint and typecheck (`python-lint.yml`)

1. Install dependencies with `uv sync --all-packages`.
2. `make py-lint` — Ruff linter and format check.
3. `make py-typecheck` — Pyright.

### Python tests (`python-test.yml`)

- Starts a Postgres 17 service container.
- Installs both Node.js 24 and Python packages.
- `make py-test` — runs all pytest tests (unit and integration). Integration tests build and start a real Next.js production server, seed a test database, and exercise the Lambda and watcher against the live API.

### TypeScript lint and typecheck (`typescript-lint.yml`)

1. Install dependencies with `npm ci`.
2. `npm run lint:check` — Biome (via Ultracite), combined formatter + linter check.
3. `npm run typecheck` — TypeScript compiler.

### TypeScript tests (`typescript-test.yml`)

- Starts a Postgres 17 service container and Node.js 24.
- `make fe-test-unit` — runs `tests/unit/` and `tests/mcp/` (in-memory MCP protocol tests) together; no Postgres, no Next.js server, no global setup. See [Testing](testing.md).
- `make fe-test-integration` — runs Vitest integration tests that test the API routes and MCP server over HTTP against a real database.

### Apply database migrations (`apply-migrations.yml`)

Triggered on pushes to `staging`/`production` (i.e. PR merges) that change files under `web/drizzle/`. The single job sets `environment: ${{ github.ref_name }}` so GitHub selects that environment's secrets and protection rules, then runs `npm run db:migrate` (Drizzle) against the environment's PostgreSQL database using the environment's `DATABASE_URL` secret. A per-branch `concurrency` group prevents overlapping migration runs.

Production is gated by a required-reviewer protection rule on the `production` GitHub environment, so production migrations pause for manual approval before applying. Each environment needs a `DATABASE_URL` secret pointing at its PostgreSQL connection string, and that database must accept connections from GitHub-hosted runners.

### Publish watcher (`publish-watcher.yml`)

Triggered on `watcher-v*` tag pushes and manual `workflow_dispatch` from `production`. The `build` job's `if:` guard refuses dispatches from any other branch so a feature branch can't accidentally publish whatever version is in its `pyproject.toml`. Builds the `data-hub-watcher` package, publishes it to PyPI via OIDC trusted publishing, and verifies the upload by installing the freshly published wheel into a clean venv. Three sequential jobs:

1. **build** — Verifies the git tag matches `watcher/pyproject.toml` (`make py-check-watcher-version`), builds the wheel and sdist with `uv build --package data-hub-watcher`, and uploads them as a workflow artifact.
2. **publish** — Downloads the artifact and uploads it to PyPI with [`pypa/gh-action-pypi-publish`](https://github.com/pypa/gh-action-pypi-publish) using OIDC trusted publishing. Gated on the `pypi` GitHub deployment environment so reviewer-required releases can be enforced from the GitHub UI without editing the workflow file.
3. **verify** — In a fresh `uv venv`, installs `data-hub-watcher==<tag-version>` from PyPI and runs `data-hub-watcher --version` plus `python -c "import data_hub_watcher"` as a smoke test. Catches stale-mirror shadows and module-level import side-effect crashes.

See the [Watcher (PyPI)](#watcher-pypi) deployment section for the operator-facing release flow.

## Branch strategy

| Branch | Purpose |
| --- | --- |
| `staging` | Pre-production environment. PRs are merged here first. |
| `production` | Live environment. Changes are promoted from `staging`. |

Feature branches target `staging` via pull requests. CI runs on every PR and on merges to both branches.

## Deployment

Data Hub is self-hosted, running across three backend pieces per environment: a PostgreSQL database, the Next.js web app plus REST API on Vercel, and the AWS S3 + Lambda stack. To stand up a new environment from scratch, follow the step-by-step [First-time deployment](first-time-deployment.md) guide. This section is the reference for how each piece is deployed and how CI redeploys it afterward.

### Web application (Vercel)

The Next.js app is deployed on [Vercel](https://vercel.com). Every branch and commit generates a preview deployment. Merges to `staging` and `production` deploy to their respective environments automatically.

Environment variables are managed in the Vercel dashboard and can be pulled locally with:

```sh
cd web
vercel env pull
```

### Database (PostgreSQL)

Give each environment (`staging`, `production`) its own dedicated PostgreSQL instance on any Postgres host.

Merges to `staging`/`production` that change files under `web/drizzle/` automatically apply migrations via the [`apply-migrations.yml`](#apply-database-migrations-apply-migrationsyml) workflow (production is gated on manual approval). The commands below are for local runs or manual application:

```sh
cd web

# Generate migration files from schema changes.
npm run db:generate

# Apply migrations.
npm run db:migrate

# Or push directly (skips migration files).
npm run db:push
```

### Lambda (AWS)

The Lambda function is deployed as a Docker container image via [AWS SAM](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/). Infrastructure is defined in `infra/template.yaml` and includes:

- S3 buckets (`arcadia-data-hub-raw-{env}` and `arcadia-data-hub-processed-{env}`)
- The Lambda function (container image, 1024 MB memory, 300 s timeout, function URL)
- S3 event triggers for each supported instrument
- IAM roles for Lambda execution, GitHub Actions deployment (OIDC), and Vercel web app S3 access (OIDC)

A separate bootstrap stack (`infra/bootstrap.yaml`) creates shared per-account resources — the ECR repository, the GitHub OIDC identity provider, and the Vercel OIDC identity provider — and only needs to be deployed once (`make sam-bootstrap`).

Standing up the stack for the first time — the one-time bootstrap, building and pushing the image, the initial `make sam-deploy`, and wiring the GitHub environment secrets and Vercel outputs — is covered step by step in [First-time deployment](first-time-deployment.md). The rest of this section is the reference for deploys after the stack exists.

#### Automated deployment (`deploy-lambda.yml`)

On pushes to `staging` or `production`, the **Deploy Lambda** workflow:

1. Assumes the environment's deploy role via OIDC (no long-lived AWS keys).
2. Builds and pushes the Docker image to ECR.
3. Runs `sam deploy` to update the CloudFormation stack.

Secrets (`DATA_HUB_API_KEY`, etc.) are stored in GitHub environment secrets scoped to each environment.

> **Note:** The CI deploy role has intentionally narrow permissions — enough to push a new container image, update the existing CloudFormation stack, modify the data buckets' S3 event notifications, and update the data buckets' CORS configuration, but _not_ enough to create the stack from scratch or to add/remove S3 buckets or Lambda functions. Initial stack creation and structural infrastructure changes must be performed by an admin with broader AWS permissions. Once the stack exists, routine image-update deploys through CI work without issue.
>
> The deploy that first grants `s3:PutBucketCORS` must be run by an admin via `make sam-deploy` (CI can't grant itself a permission and use it in the same changeset). CORS edits after that roll out through CI.
>
> The bucket policies that deny object writes from unapproved principals (`RawDataBucketPolicy`, `ProcessedDataBucketPolicy`, `ArchivesBucketPolicy`) are managed the same way: adding or changing them requires `s3:PutBucketPolicy`, which the CI role does **not** hold (by design — a routine CI role that could rewrite these policies could also disable the write protection). Apply changes to the deny lists via an admin `make sam-deploy`, not CI.

#### Local deployment

Local deployment requires the following tools in addition to the [general prerequisites](getting-started.md#prerequisites):

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) — used for bootstrap commands and ECR login.
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) — used by `make sam-deploy` to package and deploy CloudFormation stacks. Install with `brew install aws-sam-cli` on macOS.
- AWS credentials configured (`aws configure` or environment variables) with permission to deploy the stack.

Create an environment-specific `.env` file if you haven't already (see [First-time deployment → Deploy the AWS infrastructure](first-time-deployment.md#4-deploy-the-aws-infrastructure) for details on each variable):

```sh
cp infra/.env.example infra/.env.staging
# Fill in the values in infra/.env.staging
```

Then build, push, and deploy:

```sh
# Build the container image.
make docker-build-lambda

# Tag and push to ECR.
make docker-push-lambda ENV=staging

# Deploy to staging (loads infra/.env.staging automatically).
make sam-deploy ENV=staging
```

#### S3 notifications

The raw bucket uses a single catch-all `ObjectCreated:*` notification on the Lambda. New instrument types do **not** need a new `LambdaConfiguration` entry — register a processor by `instrument_type` instead (see [Lambda → Adding a new instrument / processor](lambda.md#adding-a-new-instrument--processor)). Deploy the type-dispatch handler before changing notification filters when rolling this out to an environment that still has per-ID rules.

### Watcher (PyPI)

The `data-hub-watcher` Python package is published to [PyPI](https://pypi.org/project/data-hub-watcher/) so lab PCs can install and self-update via `uv tool install data-hub-watcher`. The full release flow — version bump, tag, approval, env-var roll-out, mandatory updates, and rollback — is documented in the admin-facing [Roll out watcher releases](https://datahub.arcadiascience.com/docs/watcher-releases) guide; this section is intentionally a pointer rather than a second source of truth so the two can't drift.

Trusted publishing is configured under **Project → Publishing** on PyPI for `Arcadia-Science/data-hub` and the workflow `publish-watcher.yml`; no API token lives in repo secrets. If trust is ever revoked or rotated, update it there and re-run the workflow.

## Running checks locally

Always run the full check suite before pushing:

```sh
make check
```

This is equivalent to:

```sh
make py-check    # py-format + py-lint + py-typecheck
make fe-check    # fe-format + fe-lint + fe-typecheck
```
