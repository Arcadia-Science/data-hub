# Monorepo Structure

How to organize the repository as it grows from a Python utilities package to a multi-service system. Read [ARCHITECTURE.md](./ARCHITECTURE.md) first.

## Current State

The repository is a single Python package (`data-hub-utils`) containing the Lambda function, per-instrument workflows, and integrations with Ganymede, Notion, S3, and Slack. It is managed with `uv` and deployed as a Docker image to AWS Lambda.

## Target State

The repository will contain four concerns:

1. **Next.js web application + API** (TypeScript) — the dashboard, instrument pages, and REST API routes
2. **Lambda function** (Python) — S3-triggered file processing and report generation
3. **Watcher** (Python) — file upload service running on lab PCs
4. **Shared Python library** — code used by both the Lambda and watcher (enums, S3 utils, config, Slack)

## Recommended Layout

```
data-hub/
├── apps/
│   └── web/                           # Next.js app + API routes
│       ├── package.json
│       ├── pnpm-lock.yaml
│       ├── next.config.ts
│       ├── drizzle.config.ts
│       ├── drizzle/
│       │   └── migrations/
│       ├── src/
│       │   ├── app/
│       │   │   ├── api/               # REST API route handlers
│       │   │   │   ├── instruments/
│       │   │   │   ├── watchers/
│       │   │   │   └── instrument-runs/
│       │   │   ├── instruments/       # Instrument pages
│       │   │   ├── settings/          # Token management, sign-in
│       │   │   └── page.tsx           # Dashboard
│       │   ├── auth/                  # Auth.js config + middleware
│       │   ├── db/                    # Drizzle schema + connection
│       │   ├── lib/                   # S3 presign, helpers
│       │   └── components/            # Shared React components
│       ├── tsconfig.json
│       └── .env.local
│
├── lambda/                            # AWS Lambda function
│   ├── Dockerfile
│   ├── pyproject.toml
│   └── src/
│       └── data_hub_lambda/
│           ├── handler.py
│           ├── api_client.py
│           └── workflows/
│               ├── akta_fplc/
│               ├── azure_600_gel_doc/
│               ├── azure_cielo_qpcr/
│               ├── spectramax_id3_plate_reader/
│               ├── spectramax_id5_plate_reader/
│               └── agilent_4150_tapestation/
│
├── watcher/                           # File upload service
│   ├── pyproject.toml
│   └── src/
│       └── data_hub_watcher/
│           ├── __init__.py
│           ├── models.py
│           ├── constants.py
│           ├── config_io.py
│           ├── api_client.py
│           ├── monitor.py
│           ├── run_detector.py
│           ├── uploader.py
│           ├── heartbeat.py
│           ├── events.py
│           ├── service.py
│           └── cli.py
│
├── packages/
│   └── shared/                        # Shared Python library
│       ├── pyproject.toml
│       └── src/
│           └── data_hub_shared/
│               ├── __init__.py
│               ├── enums.py
│               ├── config.py
│               ├── constants.py
│               ├── s3_utils.py
│               ├── slack.py
│               ├── logger.py
│               └── utils.py
│
├── docs/
├── .github/workflows/
├── pyproject.toml                     # uv workspace root
├── Makefile
└── README.md
```

## uv Workspace Configuration

The root `pyproject.toml` declares a uv workspace over the three Python packages. It does not define a package itself — it only holds workspace-level tooling config (ruff, pyright).

```toml
[tool.uv.workspace]
members = ["lambda", "watcher", "packages/shared"]

[tool.ruff]
src = ["lambda/src", "watcher/src", "packages/shared/src"]
line-length = 100
indent-width = 4
extend-include = ["*.ipynb"]

# ... rest of ruff config unchanged
```

Each service declares its own dependencies and pulls in the shared library via a workspace reference.

**`packages/shared/pyproject.toml`:**

```toml
[project]
name = "data-hub-shared"
version = "0.2.0"
requires-python = ">=3.12"
dependencies = [
    "boto3>=1.40.4",
    "python-dotenv>=1.0.0",
    "requests>=2.31.0",
]

[tool.setuptools.packages.find]
where = ["src"]
```

**`lambda/pyproject.toml`:**

```toml
[project]
name = "data-hub-lambda"
version = "0.2.0"
requires-python = ">=3.12"
dependencies = [
    "data-hub-shared",
    "aws-lambda-typing>=2.20.0",
    "michaelis-menten-analysis",
    "openpyxl>=3.1.5",
    "pandas>=2.3.1",
    "scikit-image>=0.25.2",
    "tifffile>=2025.9.30",
]

[tool.uv.sources]
data-hub-shared = { workspace = true }
```

**`watcher/pyproject.toml`:**

```toml
[project]
name = "data-hub-watcher"
version = "0.2.0"
requires-python = ">=3.12"
dependencies = [
    "data-hub-shared",
    "click>=8.2.1",
    "pydantic>=2.11.9",
    "pyyaml>=6.0",
    "watchdog>=4.0.0",
]

[project.scripts]
data-hub = "data_hub_watcher.cli:cli"

[tool.uv.sources]
data-hub-shared = { workspace = true }
```

Running `uv sync` from the repository root installs all three packages in a single virtual environment, with cross-package imports working immediately.

## Code Placement

### What moves to `packages/shared`

Code that both the Lambda and watcher need:

| Current location | New location | Used by |
|---|---|---|
| `enums.py` | `packages/shared/` | Lambda (dispatch), watcher (validation) |
| `config.py` | `packages/shared/` | Lambda, watcher |
| `constants.py` | `packages/shared/` | Lambda, watcher |
| `aws/s3_utils.py` | `packages/shared/` | Lambda, watcher |
| `logger.py` | `packages/shared/` | Lambda, watcher |
| `slack.py` | `packages/shared/` | Lambda, watcher |
| `utils.py` | `packages/shared/` | Lambda, watcher |

### What moves to `lambda/`

| Current location | New location | Notes |
|---|---|---|
| `aws/lambda_function.py` | `lambda/src/data_hub_lambda/handler.py` | Entry point |
| `workflows/*` | `lambda/src/data_hub_lambda/workflows/` | Per-instrument processing |
| `lib/spectramax_plate_reader.py` | `lambda/src/data_hub_lambda/lib/` | Parsing library |
| `ganymede/` | `lambda/src/data_hub_lambda/ganymede/` | Temporary; removed after migration |
| `notion/` | `lambda/src/data_hub_lambda/notion/` | Temporary; removed after migration |

A new `api_client.py` is added in `lambda/` for writing to the Data Hub REST API (see [lambda/MIGRATION.md](./lambda/MIGRATION.md)).

### What goes in `watcher/`

All watcher code is new. The module structure matches [watcher/CONFIG_AND_VALIDATION.md](./watcher/CONFIG_AND_VALIDATION.md) but the import path changes from `data_hub_utils.watcher` to `data_hub_watcher` (see [Divergences from Existing Docs](#divergences-from-existing-docs)).

### The Next.js app is independent

`apps/web/` has its own `package.json` managed by pnpm. It shares no code with the Python side — it interacts with the Lambda and watcher exclusively through its REST API and shared S3/database conventions defined in [INTEGRATION_CONSTRAINTS.md](./INTEGRATION_CONSTRAINTS.md).

## Deployment

Each service has a distinct deployment target:

| Service | Artifact | Deploy target | Trigger |
|---|---|---|---|
| `apps/web` | Next.js build | Vercel (or similar) | Push to main, changes in `apps/web/` |
| `lambda` | Docker image | AWS ECR + Lambda | Push to main, changes in `lambda/` or `packages/shared/` |
| `watcher` | pip-installable package | Lab instrument PCs | Manual install via `uv pip install .` from `watcher/` |

### Lambda Dockerfile

The Lambda Dockerfile copies both the shared package and the lambda package into the build context:

```dockerfile
FROM ghcr.io/astral-sh/uv:0.8.12 AS uv

FROM public.ecr.aws/lambda/python:3.13 AS builder

RUN dnf install -y git

ENV UV_COMPILE_BYTECODE=1
ENV UV_NO_INSTALLER_METADATA=1
ENV UV_LINK_MODE=copy

RUN --mount=from=uv,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=lambda/uv.lock,target=uv.lock \
    --mount=type=bind,source=lambda/pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=packages/shared/pyproject.toml,target=packages/shared/pyproject.toml \
    --mount=type=bind,source=packages/shared/src,target=packages/shared/src \
    --mount=type=secret,id=GIT_AUTH_TOKEN \
    export GIT_AUTH_TOKEN=$(cat /run/secrets/GIT_AUTH_TOKEN) && \
    git config --global url."https://${GIT_AUTH_TOKEN}@github.com/".insteadOf "https://github.com/" && \
    uv export --frozen --no-emit-workspace --no-dev --no-editable -o requirements.txt && \
    uv pip install -r requirements.txt --target "${LAMBDA_TASK_ROOT}"

FROM public.ecr.aws/lambda/python:3.13

COPY --from=builder ${LAMBDA_TASK_ROOT} ${LAMBDA_TASK_ROOT}
COPY packages/shared/src ${LAMBDA_TASK_ROOT}
COPY lambda/src ${LAMBDA_TASK_ROOT}

CMD ["data_hub_lambda.handler.lambda_handler"]
```

### Watcher installation on lab PCs

The watcher is installed directly from the repository (or a built wheel):

```bash
uv pip install ./packages/shared ./watcher
```

This installs the `data-hub` CLI entry point defined in `watcher/pyproject.toml`.

## CI/CD

### GitHub Actions workflows

| Workflow | Trigger | Scope |
|---|---|---|
| `lint-and-typecheck.yml` | All PRs | ruff + pyright on Python workspace; ESLint + tsc on `apps/web` |
| `test.yml` | All PRs | pytest for Python; vitest / Playwright for web |
| `deploy-lambda-staging.yml` | Push to main | Docker build from `lambda/` + `packages/shared/` |
| `deploy-lambda-production.yml` | Manual dispatch | Same build, production ECR |
| `deploy-web.yml` | Push to main | Vercel deploy from `apps/web/` |

Use path filters to avoid unnecessary builds:

```yaml
on:
  push:
    paths:
      - 'lambda/**'
      - 'packages/shared/**'
      - '.github/workflows/deploy-lambda-*.yml'
```

### Makefile

The root Makefile dispatches to each service:

```makefile
.PHONY: lint format typecheck test

lint:
	uv run ruff check --exit-zero .
	uv run ruff format --check .
	cd apps/web && pnpm lint

format:
	uv run ruff check --fix .
	uv run ruff format .
	cd apps/web && pnpm format

typecheck:
	uv run pyright --project pyproject.toml .
	cd apps/web && pnpm typecheck

test:
	uv run pytest -v .
	cd apps/web && pnpm test
```

## Divergences from Existing Docs

This layout changes the watcher import path from what is described in [watcher/CONFIG_AND_VALIDATION.md](./watcher/CONFIG_AND_VALIDATION.md):

| Document says | This layout uses | Reason |
|---|---|---|
| `src/data_hub_utils/watcher/` | `watcher/src/data_hub_watcher/` | Separate package avoids pulling Lambda dependencies onto lab PCs |
| `from data_hub_utils.watcher.models import ...` | `from data_hub_watcher.models import ...` | Follows from the package rename |

The module structure (filenames and responsibilities) is unchanged — only the top-level package name differs. The watcher docs should be updated to reflect the new import path when the restructure is performed.

Similarly, [lambda/MIGRATION.md](./lambda/MIGRATION.md) references adding an API client "to the Lambda codebase." In this layout, the Lambda-specific API client lives at `lambda/src/data_hub_lambda/api_client.py` rather than inside `data_hub_utils`.

## Alternative: Single Python Package

If the overhead of three Python packages is not justified early on, keep all Python code in a single `data-hub-utils` package (matching the current structure) and add the Next.js app alongside it:

```
data-hub/
├── apps/
│   └── web/                       # Next.js (new)
├── src/
│   └── data_hub_utils/
│       ├── aws/
│       ├── workflows/
│       ├── watcher/               # As specified in existing docs
│       ├── ganymede/
│       ├── notion/
│       ├── lib/
│       └── ...
├── docs/
├── pyproject.toml                 # Single Python package
├── Dockerfile
└── README.md
```

This preserves all existing doc references unchanged. The tradeoff is that the watcher installation on lab PCs pulls in Lambda-only dependencies (pandas, scikit-image, etc.) unless managed via optional dependency groups:

```toml
[project.optional-dependencies]
watcher = ["click", "pyyaml", "watchdog"]
lambda = ["pandas", "openpyxl", "scikit-image", "tifffile"]
```

The Lambda Dockerfile would install with `uv pip install .[lambda]` and lab PCs with `uv pip install .[watcher]`.

This approach works well initially and can be split into a uv workspace later if dependency separation becomes a real concern.

## Migration Path

1. Create `apps/web/` and scaffold the Next.js project (independent of any Python changes).
2. Build the watcher as either `data_hub_utils.watcher` (single package) or `data_hub_watcher` (workspace package).
3. Once the Lambda migration ([lambda/MIGRATION.md](./lambda/MIGRATION.md)) removes the Ganymede and Notion dependencies, perform the package split if using the single-package approach initially.
4. Update CI/CD workflows to add path-filtered triggers for each service.
