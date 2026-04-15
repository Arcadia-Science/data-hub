# CI and deployment

## GitHub Actions

Four workflows run on pushes to `staging`/`production` and on pull requests targeting those branches.

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
2. `npm run format:check` — Prettier.
3. `npm run lint` — ESLint.
4. `npm run typecheck` — TypeScript compiler.

### TypeScript tests (`typescript-test.yml`)

- Starts a Postgres 17 service container and Node.js 24.
- `make fe-test-mcp` — runs in-memory MCP protocol tests (mocked data layer, no database).
- `make fe-test-integration` — runs Vitest integration tests that test the API routes and MCP server over HTTP against a real database.

## Branch strategy

| Branch | Purpose |
| --- | --- |
| `staging` | Pre-production environment. PRs are merged here first. |
| `production` | Live environment. Changes are promoted from `staging`. |

Feature branches target `staging` via pull requests. CI runs on every PR and on merges to both branches.

## Deployment

### Web application (Vercel)

The Next.js app is deployed on [Vercel](https://vercel.com/arcadia-science/data-hub). Every branch and commit generates a preview deployment. Merges to `staging` and `production` deploy to their respective environments automatically.

Environment variables are managed in the Vercel dashboard and can be pulled locally with:

```sh
cd web-app
vercel env pull
```

### Database (Render)

Staging and production each have a dedicated PostgreSQL instance hosted on [Render](https://dashboard.render.com/project/prj-d75d0jma2pns738r4110).

Schema changes are applied with Drizzle:

```sh
cd web-app

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

A separate bootstrap stack (`infra/bootstrap.yaml`) creates shared resources — the ECR repository, the GitHub OIDC identity provider, and the Vercel OIDC identity provider — and only needs to be deployed once:

```sh
make sam-bootstrap
```

#### First-time AWS setup

After deploying the bootstrap stack, follow these steps to bring up the first environment. You need admin-level AWS credentials for the initial deploy (the CI role cannot create stacks from scratch).

**1. Get the bootstrap stack outputs:**

```sh
aws cloudformation describe-stacks \
  --stack-name data-hub-bootstrap \
  --region us-west-1 \
  --query "Stacks[0].Outputs"
```

Note the `GitHubOidcProviderArn`, `VercelOidcProviderArn`, and `EcrRepositoryUri` values — you'll need them in steps 3 and 4 below.

> **Note:** If your AWS account already has an OIDC provider for `token.actions.githubusercontent.com` (from another project), the bootstrap stack will fail with an `AWS::EarlyValidation::ResourceExistenceCheck` error. In that case, remove the `GitHubOidcProvider` resource from `bootstrap.yaml` (or skip the bootstrap stack entirely) and use the existing provider's ARN. Check with `aws iam list-open-id-connect-providers`.

**2. Build and push the Docker image to ECR:**

```sh
# Log in to ECR.
aws ecr get-login-password --region us-west-1 \
  | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-west-1.amazonaws.com

# Build the image.
make docker-build-lambda

# Tag and push.
docker tag data-hub-lambda:latest <ECR_REPOSITORY_URI>:staging-initial
docker push <ECR_REPOSITORY_URI>:staging-initial
```

**3. Deploy the per-environment stack:**

Set the required environment variables (the `samconfig.toml` references them via `${...}`) and deploy:

```sh
export ECR_IMAGE_URI="<ECR_REPOSITORY_URI>:staging-initial"
export DATA_HUB_API_URL="https://data-hub-env-staging-arcadia-science.vercel.app/api/v1"
export DATA_HUB_API_KEY="<your-api-key>"
export SLACK_WEBHOOK_URL="<your-slack-webhook>"
export GITHUB_OIDC_PROVIDER_ARN="<github-oidc-arn-from-step-1>"
export VERCEL_OIDC_PROVIDER_ARN="<vercel-oidc-arn-from-step-1>"
export LAMBDA_INVOKE_TOKEN="<shared-secret-for-function-url-auth>"

make sam-deploy ENV=staging
```

Repeat with the production values and `make sam-deploy ENV=production` when ready.

**4. Configure GitHub environment secrets:**

After the stack deploys, grab the deploy role ARN:

```sh
aws cloudformation describe-stacks \
  --stack-name data-hub-staging \
  --region us-west-1 \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" \
  --output text
```

In your GitHub repo, go to **Settings → Environments**, create a `staging` environment (and later `production`), and add these secrets:

| Secret | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | Deploy role ARN from the stack output |
| `GH_OIDC_PROVIDER_ARN` | GitHub OIDC provider ARN from the bootstrap stack |
| `VERCEL_OIDC_PROVIDER_ARN` | Vercel OIDC provider ARN from the bootstrap stack |
| `SAM_S3_BUCKET` | SAM CLI managed S3 bucket name (see `sam deploy` output, e.g. `aws-sam-cli-managed-default-samclisourcebucket-*`) |
| `DATA_HUB_API_URL` | Base API URL for the environment |
| `DATA_HUB_API_KEY` | API key for Lambda → Data Hub authentication |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |
| `LAMBDA_INVOKE_TOKEN` | Shared secret for web app → Lambda Function URL authentication |

You'll also need the `WebAppRoleArn` and `DataHubFunctionUrl` stack outputs to configure the Vercel web app. In the Vercel dashboard (under the appropriate environment), set:

| Vercel env var | Value |
| --- | --- |
| `AWS_ROLE_ARN` | `WebAppRoleArn` stack output — lets the web app generate presigned S3 URLs via OIDC federation |
| `LAMBDA_FUNCTION_URL` | `DataHubFunctionUrl` stack output — the Lambda Function URL for manual reprocessing |
| `LAMBDA_INVOKE_TOKEN` | Same shared secret configured in the GitHub environment secret above |

Once secrets are set, the CI workflow handles all subsequent deploys automatically.

#### Automated deployment (`deploy-lambda.yml`)

On pushes to `staging` or `production`, the **Deploy Lambda** workflow:

1. Assumes the environment's deploy role via OIDC (no long-lived AWS keys).
2. Builds and pushes the Docker image to ECR.
3. Runs `sam deploy` to update the CloudFormation stack.

Secrets (`DATA_HUB_API_KEY`, `SLACK_WEBHOOK_URL`, etc.) are stored in GitHub environment secrets scoped to each environment.

> **Note:** The CI deploy role has intentionally narrow permissions — enough to push a new container image and update the existing CloudFormation stack, but _not_ enough to create the stack from scratch or to add/remove S3 buckets, Lambda functions, or S3 event triggers. Initial stack creation and infrastructure-level changes (e.g., adding a new instrument trigger) must be performed by an admin with broader AWS permissions. Once the stack exists, routine image-update deploys through CI work without issue.

#### Local deployment

Local deployment requires the following tools in addition to the [general prerequisites](getting-started.md#prerequisites):

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) — used for bootstrap commands and ECR login.
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) — used by `make sam-deploy` to package and deploy CloudFormation stacks. Install with `brew install aws-sam-cli` on macOS.
- AWS credentials configured (`aws configure` or environment variables) with permission to deploy the stack.

Once installed, build and deploy:

```sh
# Build the container image.
make docker-build-lambda

# Deploy to staging (will prompt for changeset confirmation).
make sam-deploy ENV=staging

# Deploy to production.
make sam-deploy ENV=production
```

## Running checks locally

Always run the full check suite before pushing:

```sh
make check-all
```

This is equivalent to:

```sh
make py-check    # py-format + py-lint + py-typecheck
make fe-check    # fe-format + fe-lint + fe-typecheck
```
