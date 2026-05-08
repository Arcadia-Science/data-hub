# Data Hub

Data Hub is a platform for automatically ingesting, processing, and visualizing data from laboratory instruments. Lab instrument PCs run a **watcher** agent that uploads raw files to S3, an AWS **Lambda** function processes them through instrument-specific pipelines, and a **Next.js** web application provides a dashboard and REST API backed by PostgreSQL.

```mermaid
flowchart LR
    W[Watcher] -->|raw files| S3[S3]
    S3 -->|trigger| L[Lambda]
    W -->|heartbeats, runs| API[API]
    L -->|results| API
    API --> DB[(PostgreSQL)]
    API --> UI[Web app]
```

## Repository structure

| Directory | Description | Docs |
| --- | --- | --- |
| `web-app/` | Next.js web application and REST API (Vercel) | [API reference](docs/api.md) |
| `lambda/` | AWS Lambda function for instrument data processing | [Lambda docs](docs/lambda.md) |
| `watcher/` | CLI agent for lab instrument PCs | [Watcher docs](docs/watcher.md) |
| `packages/shared/` | Shared Python library (S3, enums, test infra) | [Shared library](docs/shared-library.md) |
| `docs/` | Project documentation | — |

## Quick start

```sh
# Install Python packages (all workspace members).
uv sync --all-packages

# Install web app dependencies.
cd web-app && npm install && cd ..

# Set up environment variables for the web app.
cd web-app && vercel env pull && cd ..

# Create and initialize the local database.
cd web-app && createdb data-hub-local && npm run db:push && cd ..

# Start the dev server.
make dev
```

See the full [Getting Started guide](docs/getting-started.md) for prerequisites and details.

## Documentation

### Guides

- [Adding an instrument](docs/guides/adding-an-instrument.md) — end-to-end: watcher setup, activation, optional Lambda preprocessing
- [Installing a watcher](docs/guides/installing-a-watcher.md) — lab operator focused: init, watch, troubleshooting
- [Managing tokens](docs/guides/managing-tokens.md) — creating, using, and revoking API tokens

### Reference

- [Architecture](docs/architecture.md) — system overview, data flow, and design decisions
- [Getting started](docs/getting-started.md) — development setup, environment variables, running locally
- [Watcher](docs/watcher.md) — CLI commands, configuration, run detection, upload modes
- [Lambda](docs/lambda.md) — processing pipeline, supported instruments, adding new instruments
- [REST API](docs/api.md) — endpoint reference and authentication
- [MCP server](docs/mcp.md) — tools, resources, prompts, and installation for Claude Desktop / Cursor
- [Shared library](docs/shared-library.md) — module reference for `data-hub-shared`
- [CI and deployment](docs/ci-and-deployment.md) — GitHub Actions, Vercel, Render, Lambda deployment
- [Conventions](docs/conventions.md) — S3 key layout, instrument IDs, code style, environments

## Development

```sh
# Run formatting, linting, and type checking.
make check-all

# Run all Python tests.
make py-test

# Run Python unit tests only.
make py-test-unit

# Run Python integration tests (requires Postgres).
make py-test-integration

# Run API integration tests (requires Postgres).
make fe-test-integration
```
