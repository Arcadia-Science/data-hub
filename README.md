# Data Hub

Data Hub collects the files that lab instruments write and makes them searchable in one place. A small program called the watcher runs on each instrument PC, uploads new files to S3 as they appear, and groups them into runs. An AWS Lambda reads each supported file format, and a Next.js web app, REST API, and MCP server let people and scripts find, view, and download the results.

Nobody signs up for Data Hub. Your team deploys it, so raw instrument data and everything derived from it stay on infrastructure you control. The source is MIT licensed.

[Documentation](https://datahub.arcadiascience.com/docs) · [Set up an instrument](https://datahub.arcadiascience.com/docs/set-up-an-instrument) · [Deploy it yourself](docs/developer/first-time-deployment.md) · [Architecture](docs/developer/architecture.md)

<!-- These are the docs site's screenshots, retaken by `make docs-screenshots`. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/site/public/images/home.dark.webp">
  <img alt="The Data Hub dashboard, showing run counts, instrument status, and a table of recent runs" src="docs/site/public/images/home.webp">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/site/public/images/plate-reader-runs-table.dark.webp">
  <img alt="The runs table for a SpectraMax iD5 plate reader, with wavelength, measurement mode, and measurement type columns" src="docs/site/public/images/plate-reader-runs-table.webp">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/site/public/images/plate-reader-run-details-1.dark.webp">
  <img alt="A plate reader run detail page showing measurement metadata, a file list, and a color-coded plate map" src="docs/site/public/images/plate-reader-run-details-1.webp">
</picture>

## Web app, REST API, and MCP

A run shows up in three places at once:

- **Web app**: find a run by instrument, date, or who ran it, read plate maps and images in the page, claim your work, and download files. See the [web app guide](https://datahub.arcadiascience.com/docs/browse-runs).
- **REST API**: served at `/api/v1/`, with an OpenAPI 3.1 document at `/api/v1/openapi.json` so you can generate a client instead of writing one. See the [API reference](https://datahub.arcadiascience.com/docs/api).
- **MCP server**: served at `/mcp/v1`, so Claude Code, Claude Desktop, or Cursor can search runs and fetch files during a conversation. See the [MCP setup](https://datahub.arcadiascience.com/docs/mcp).

People sign in to the web app with Google. Scripts call the REST API with a personal access token that an admin creates in the app, with only the scopes it needs. AI clients sign in to the MCP server through the browser and act with the permissions of the person who approved them.

## Supported instruments

Nine instrument types have a processor. After upload, it reads the vendor's format and writes metadata and viewable files next to the untouched original:

| Instrument | What processing adds |
| --- | --- |
| SpectraMax iD3 and iD5 plate readers | Well-data CSV and interactive plate maps |
| Azure 600 gel doc | Contrast-enhanced PNG preview and imaging settings |
| Azure Cielo qPCR | Dye channels, melting curves, and the instrument's PDF report |
| Agilent 4150 TapeStation | Tape type and the run report |
| Cytiva ÄKTA FPLC | Chromatography run report |
| Epson V700 scanner | Plate preview and colony measurements |
| Hina microscope (Nikon ND2) | Channel overlay JPG, channel list, and a video of each time-lapse |
| DishCam time-lapse camera | A video of each photo stack and the camera settings |
| Unchained Labs Aunty | A plate with a curve chart in each well, and the experiment settings |

An instrument with no matching processor still uploads, and its files stay searchable and downloadable. It gets no extracted metadata or previews. Adding a type takes code changes in `web/` and `lambda/`, described in [Lambda](docs/developer/lambda.md).

## How it works

```mermaid
flowchart LR
    W[Watcher] -->|raw files| S3[(S3)]
    W -->|runs, heartbeats| API[REST API + MCP]
    S3 -->|upload event| L[Lambda]
    L -->|processed files| S3
    L -->|metadata| API
    API --> DB[(PostgreSQL)]
    UI[Web app] --> API
    AI[AI clients] --> API
```

Four components coordinate through S3 and the API. The watcher and the Lambda never talk to each other: the watcher writes files to S3, and each upload starts the Lambda. File contents move directly between S3 and the client over short-lived presigned URLs, without passing through the web app.

| Directory | Package | Role |
| --- | --- | --- |
| `web/` | `data-hub-web` | Next.js dashboard, REST API, and MCP server, backed by PostgreSQL. Runs on Vercel. |
| `lambda/` | `data-hub-lambda` | AWS Lambda triggered by S3 uploads. Runs the per-instrument processors and builds run archives. |
| `watcher/` | `data-hub-watcher` | Command-line program that runs on instrument PCs, published to PyPI. Detects runs, uploads files, reports health. |
| `packages/shared/` | `data-hub-shared` | S3 utilities, instrument enums, and test infrastructure shared by the two Python packages. |
| `infra/` | | AWS SAM templates for the S3 buckets, the Lambda, and the IAM roles. |
| `docs/site/` | | The public documentation site at `/docs`, built with Fumadocs. |
| `docs/developer/` | | Contributor and self-hosting documentation, plain Markdown that the site does not render. |

[Architecture](docs/developer/architecture.md) covers the full data flow, both upload modes, and the reasoning behind each design decision.

## Documentation

Docs are split by who is reading:

- **Using Data Hub**: [datahub.arcadiascience.com/docs](https://datahub.arcadiascience.com/docs) covers installing the watcher, setting up an instrument, browsing runs, issuing tokens, permissions, and reference pages for the watcher command line, the API, and MCP. It is built from [docs/site/](docs/site/README.md).
- **Building or hosting Data Hub**: [docs/developer/](docs/developer/README.md) covers local setup, architecture, testing, conventions, CI, and the deployment runbooks.

## Run it locally

The web app, API, and database run with no AWS or Google credentials, which is enough for work on the UI, REST endpoints, MCP tools, or the schema. You need PostgreSQL 15 or later and Node.js 24 with npm 11:

```sh
cd web && npm install && cd ..
createdb data-hub-local
# Create web/.env. The keys it needs are listed in docs/developer/local-development.md.
make db-reseed
make dev
```

Open `http://localhost:3000/login` and use the **Sign in (dev)** button with `alice@example.com`. `make db-reseed` seeds instruments, runs, and files, and prints a personal access token for API calls.

Changing the watcher or the Lambda needs Python 3.13 and [uv](https://docs.astral.sh/uv/) as well, then `uv sync --all-packages`. [Getting started](docs/developer/getting-started.md) lists the full prerequisites; [Local development](docs/developer/local-development.md) explains the zero-credential path, including how to render real file bytes from a local S3 mirror.

## Deploy your own

A deployment is a PostgreSQL database, the web app on Vercel, three S3 buckets, and one Lambda. A Google OAuth client created during the deploy decides who can sign in at all. [First-time deployment](docs/developer/first-time-deployment.md) walks through it in order, and [CI and deployment](docs/developer/ci-and-deployment.md) covers the `staging` and `production` branches and what redeploys on merge.

## Checks and tests

Run both before opening a pull request:

```sh
make check  # Format, lint, and type-check Python and TypeScript.
make test   # Python and web tests, unit and integration.
```

Integration tests need PostgreSQL, and the web suite builds the app into `web/.next`, so stop `make dev` before running them. [Testing](docs/developer/testing.md) describes each suite and the shared test server; [Conventions](docs/developer/conventions.md) covers S3 key layout, instrument IDs, and code style.

## License

Data Hub is released under the [MIT License](LICENSE). Copyright (c) 2026 Arcadia Science.

“Data Hub” and “Arcadia Science”, along with related names and logos, are marks of Arcadia Science. The MIT License covers the source code only and does not grant any right to use these names or logos.
