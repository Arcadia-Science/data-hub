# CI and deployment

## GitHub Actions

Two workflows run on pushes to `staging`/`production` and on pull requests targeting those branches.

### Lint and typecheck (`lint-and-typecheck.yml`)

Runs formatting, linting, and type checking for both Python and the web app in parallel.

**Python job:**
1. Install dependencies with `uv sync --all-packages`.
2. `make py-lint` — Ruff linter and format check.
3. `make py-typecheck` — Pyright.

**Web app job:**
1. Install dependencies with `npm ci`.
2. `npm run format:check` — Prettier.
3. `npm run lint` — ESLint.
4. `npm run typecheck` — TypeScript compiler.

### Tests (`test.yml`)

Runs three test jobs in parallel.

**Python unit tests:**
- `make py-test-unit` — runs all pytest tests not marked `integration`.

**Python integration tests:**
- Starts a Postgres 17 service container.
- Installs both Node.js 24 and Python packages.
- `make py-test-integration` — runs pytest tests marked `integration`. These build and start a real Next.js production server, seed a test database, and exercise the Lambda and watcher against the live API.

**API integration tests:**
- Same Postgres + Node.js setup as above.
- `make fe-test-integration` — runs Vitest integration tests in the web app that test the API routes.

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

The Lambda function is deployed as a Docker container image.

```sh
# Build the container image.
make docker-build
```

This requires a `GH_PERSONAL_ACCESS_TOKEN` in your `.env` file (for a private Git dependency). The image is built from `lambda/Dockerfile` and uses the `public.ecr.aws/lambda/python:3.12` base image.

Deployment to AWS (pushing to ECR and updating the Lambda function) is handled outside this repository.

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
