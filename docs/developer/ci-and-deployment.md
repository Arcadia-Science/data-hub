# CI and deployment

## GitHub Actions

Five workflows run on pushes to `staging`/`production` and on pull requests targeting those branches. A sixth (`apply-migrations.yml`) runs on merges to `staging`/`production` that touch migration files, and a seventh (`publish-watcher.yml`) runs only on `watcher-v*` tag pushes and manual dispatch.

### Python lint and typecheck (`python-lint.yml`)

1. Install dependencies with `uv sync --all-packages`.
2. `make py-lint` — Ruff linter and format check.
3. `make py-typecheck` — Pyright.

### Python tests (`python-test.yml`)

- Starts a Postgres 17 service container.
- Installs both Node.js 24 and Python packages.
- `make py-test` — runs all pytest tests (unit and integration). Integration tests build and start a real Next.js production server, seed a test database, and exercise the Lambda and watcher against the live API.
- `make py-watcher-cli-catalog`, then fails if `docs/site/src/lib/cli-catalog.snapshot.json` changed. The docs site renders its watcher CLI reference from that committed file, so a change to the CLI or a watcher version bump has to commit the regenerated snapshot.

### TypeScript lint and typecheck (`typescript-lint.yml`)

1. Install dependencies with `npm ci`.
2. `npm run lint:check` — Biome (via Ultracite), combined formatter + linter check.
3. `npm run typecheck` — TypeScript compiler.
4. `npm run openapi:generate` and `npm run mcp-catalog:generate`, then fails if `docs/site/src/lib/openapi.snapshot.json` or `mcp-catalog.snapshot.json` changed. The docs site renders its API and MCP reference pages from those committed files. Run `make docs-catalogs` and commit the result to fix a failure.

### Docs lint, typecheck, and link check (`docs-lint.yml`)

Runs when `docs/**`, `web/lib/docs.ts`, `web/content/changelog/**`, or `web/microfrontends.json` changes. It works in `docs/site` with Node.js 24:

1. Install dependencies with `npm ci`.
2. `npm run lint:check` — Biome (via Ultracite), combined formatter + linter check.
3. `npm run typecheck` — generates page types (which also fails on bad MDX) and runs the TypeScript compiler.
4. `npm run check:links` — checks that the page names in `web/lib/docs.ts`, the `docs:` links in changelog entries, the GitHub links from the site to `docs/developer`, and the relative links inside `docs/developer` all point at something that exists. It does not check `#heading` anchors.

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

Preview deployments assume the staging web-app IAM role only. The production role must never trust `environment:preview` OIDC subjects — a preview is just a branch push, so that trust would bypass production branch protection. `infra/template.yaml` enforces this with the `AllowPreviewSubject` condition.

Environment variables are managed in the Vercel dashboard and can be pulled locally with:

```sh
cd web
vercel env pull
```

When a push changes only files under `docs/`, the web project skips its build. `web/vercel.json` sets `ignoreCommand` to `web/scripts/vercel-ignore-build.sh`, which compares the pushed commit with the last successful deployment and builds whenever any file outside `docs/` changed.

### Docs site

The docs site in `docs/site/` is its own Vercel project (`data-hub-docs`), separate from the web app. It is served at `/docs` on the web app's domain through [Vercel Microfrontends](https://vercel.com/docs/microfrontends). Both apps read the same routing config, `web/microfrontends.json`.

The project's settings:

| Setting | Value |
| --- | --- |
| Git repository | `Arcadia-Science/data-hub` |
| Root Directory | `docs/site` |
| Production branch | `production` |
| Include source files outside of the Root Directory in the Build Step | On (the build reads `web/microfrontends.json`) |

Production deploys when `staging` is promoted to `production`, at the same moment as the web app changes the docs describe. Every other branch and pull request gets a preview deployment. `docs/site/vercel.json` sets `ignoreCommand` to `docs/site/scripts/vercel-ignore-build.sh`, which skips the build when nothing under `docs/site/` or `web/microfrontends.json` changed since the last successful deployment. Changes to `docs/developer/` never rebuild the site, because the site does not render them.

The docs build needs no network. The API, MCP, and watcher CLI reference pages render from the three snapshot files in `docs/site/src/lib/`, which CI keeps in sync with the code (see the TypeScript lint and Python tests workflows above).

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
- The Lambda function (container image, 10,240 MB memory, 900 s timeout, function URL)
- S3 event triggers for each supported instrument
- IAM roles for Lambda execution, GitHub Actions deployment (OIDC), and Vercel web app S3 access (OIDC)

A separate bootstrap stack (`infra/bootstrap.yaml`) creates shared per-account resources — the per-environment ECR repositories, the GitHub OIDC identity provider, and the Vercel OIDC identity provider — and only needs to be deployed once (`make sam-bootstrap`).

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
> Lifecycle rules are the same kind of change. The CI role does not have `s3:PutLifecycleConfiguration`, so the raw bucket's rule that deletes unfinished multipart uploads after 7 days (`AbortIncompleteMultipartUploads` on `RawDataBucket`) has to be applied by an admin with `make sam-deploy`. Writing a lifecycle configuration replaces the whole configuration. Before that deploy, run `aws s3api get-bucket-lifecycle-configuration --bucket arcadia-data-hub-raw-<env>` and copy any rule that was added by hand into `infra/template.yaml`. The template defines the raw bucket's only lifecycle rule.
>
> The bucket policies that deny object writes from unapproved principals (`RawDataBucketPolicy`, `ProcessedDataBucketPolicy`, `ArchivesBucketPolicy`) are managed the same way: adding or changing them requires `s3:PutBucketPolicy`, which the CI role does **not** hold (by design — a routine CI role that could rewrite these policies could also disable the write protection). Apply changes to the deny lists via an admin `make sam-deploy`, not CI. The same policies also deny bucket-configuration actions (`s3:PutBucketPolicy`, `s3:DeleteBucketPolicy`, `s3:PutBucketAcl`, `s3:PutBucketPublicAccessBlock`, `s3:PutBucketVersioning`) to everyone except the account root and the admin principal named by the `AdminDeployPrincipalArn` stack parameter, so no other principal in the account can disable the write protection either.
>
> Staging roles carry a permissions boundary (`data-hub-boundary-staging`) that caps their permissions at the actions they already use and explicitly denies access to production buckets, production roles, the production Lambda function, and the production ECR repository. Managed-policy attachment, role creation, and trust-policy changes are admin-only in both environments — with them, a CI role could escalate itself to `AdministratorAccess`. Widening the boundary or changing those grants takes an admin `make sam-deploy`.
>
> The optional VPC, NAT gateway, and processing alarms are the same kind of change. CI cannot create a VPC, a NAT gateway, an SNS topic, or a CloudWatch alarm. The first deploy that turns `EnableS3Files` on, and any later change to that network or to the alarms, has to be an admin `make sam-deploy`. That deploy reads `ENABLE_S3_FILES` from `infra/.env.<env>`. The GitHub environment variable `ENABLE_S3_FILES` only affects later CI deploys, so set both to the same value, `true` or `false`, before the admin deploy. If they differ, the next CI deploy tries to add or remove the network, lacks the permission, and rolls back. The workflow passes the variable on every run, and an empty value is rejected, so a deploy that forgets it stops instead of deleting the network. `ALARM_EMAIL` is optional. A new address has to confirm the subscription from the message AWS sends.
>
> Roll out to production in this order:
>
> 1. Set the `production` GitHub environment variables, and the same values in `infra/.env.production`.
> 2. Run `make sam-deploy ENV=production` from the exact commit being promoted.
> 3. Push that commit to `production`.
>
> An admin deploy from an unmerged branch leaves a gap. Any push to `production` before the promotion, such as a hotfix, makes CI deploy the old template. That deploy tries to delete the alarms, lacks the permission, and rolls back.
>
> Turning `EnableS3Files` off later also needs an admin deploy. The execution role keeps its VPC permissions either way, because Lambda deletes the function's network interface with that role after the function leaves the VPC. That can take up to 20 minutes, which can outlast CloudFormation's delete attempts. A delete that fails during cleanup is dropped from the stack, the stack still reports `UPDATE_COMPLETE`, and a second deploy does not retry it. After turning the option off:
>
> 1. Check the stack events for `DELETE_FAILED`.
> 2. If the subnets or security group were left behind, wait for the function's network interface to disappear.
> 3. Delete the security group, the subnets, and the VPC by hand.
>
> If the function stays in the VPC and is idle for 14 days, Lambda reclaims that interface and the next invocation fails until the interface is recreated. S3 events retry on their own. A reprocess or archive build can fail once.
>
> The NAT gateway is about $39 a month per environment ($0.048 an hour, plus $0.005 an hour for its public IPv4 address, plus $0.048 per GB of API traffic). S3 reads use a free gateway endpoint and do not go through the NAT gateway. One NAT gateway serves both private subnets, so an outage in its availability zone cuts the Lambda off from the API; a second gateway would double the cost. Leave `EnableS3Files` at `false` unless the environment needs it.
>
> With `EnableS3Files` on, the raw bucket is also mounted in the Lambda at `/mnt/raw` through Amazon S3 Files. Lambda mounts the file system every time it starts an execution environment, before any code reads the mount. A broken file system policy, security group, or execution role therefore stops all processing, not only the files that would use the mount.
>
> The file system policy denies writes and root access to everyone, and denies mounting except for this environment's Lambda role through the stack's access point. The S3 Files sync role has the read and write permissions AWS documents, and the raw bucket policy exempts it from the write block, because S3 Files refuses to create the file system otherwise. Since nothing can write through the mount, the sync role never has a change to copy back.
>
> Turn `EnableS3Files` on in its own admin deploy, after this template is already live with it off. CloudFormation updates the raw bucket policy only after it creates the file system, so the sync role's exemption has to be in place from an earlier deploy. A deploy that upgrades the template and turns the mount on at once fails while creating `RawFilesFileSystem` with "does not have permission to call s3:HeadObject", and rolls back. S3 Files write actions are not in the CI role, so changing the file system policy takes an admin `make sam-deploy`. The staging boundary enforces this in staging. In production the CI role can edit its own inline policies, so there the rule relies on code review.
>
> The raw bucket's notification configuration turns on EventBridge delivery while the mount is on, because S3 replaces the whole configuration on every write and a later deploy would otherwise drop it.
>
> Opening a file on the mount imports metadata for every entry in each folder on its path: the root, the instrument folder, and the run folder. S3 Files never removes that metadata, and each entry is billed. Use the mount only for files that need it, and never list or walk folders there.
>
> Before the admin deploy that first creates the file system, check the raw bucket's `NumberOfObjects` metric in CloudWatch (`AWS/S3`, `StorageType=AllStorageTypes`). The metric counts old versions too. Above about 12 million objects, `RawFilesFileSystem` needs `AcceptBucketWarning: true`, and setting that later replaces the file system.
>
> Staging needs an admin deploy for this change even with `ENABLE_S3_FILES=false`. The permissions boundary changes either way, and the CI role does not have `iam:CreatePolicyVersion`. After the admin deploy, upload a test file to staging and confirm it processes.

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
