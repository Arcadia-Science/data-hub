# Conventions

Team agreements and standards for the Data Hub codebase.

## S3 key layout

All raw data files are stored in S3 with the key pattern:

```
{instrument_id}/{run_id}/{filename}
```

- **`instrument_id`** — kebab-case identifier for the instrument row (e.g., `akta-fplc`).
- **`run_id`** — unique identifier for the run, either extracted from the filename prefix or from a subdirectory name.
- **`filename`** — the original filename.

The S3 bucket name follows the template `arcadia-data-hub-raw-{environment}`, where `environment` is `staging` or `production`.

## Instrument IDs and types

Instrument IDs are kebab-case strings (lowercase letters, numbers, hyphens). They serve as:

- S3 key prefixes
- API resource identifiers
- Primary keys on the `instruments` table

Lambda dispatch and web reprocess eligibility use **`instrument_type`**, not the ID. When adding a processable instrument:

1. Set (or add) the appropriate `instrument_type` on the instrument row
2. Register a processor for that type in `lambda/src/data_hub_lambda/processors.py`
3. Add the same type to `PROCESSABLE_INSTRUMENT_TYPES` in `web/lib/instruments/processable-types.ts`

The shared `Instrument` enum in `packages/shared` is optional legacy naming for watcher/CLI display — it is not the Lambda support gate.

## Run IDs in URLs

A run ID comes from a folder or file name, so it can hold `%`, `#`, `?`, spaces, and non-ASCII characters. Instrument IDs are slugs, so they can't.

- **Building a URL.** Encode the run ID once, as a single path segment: `encodeURIComponent` in TypeScript and `quote(run_id, safe="")` in Python. The watcher and the Lambda each do this in `_path_segment` in their `api_client.py`.
- **Reading a URL in the web app.** A route handler under `runs/[runId]` and the run page read the run ID with `readRunIdParam(headers, param)` from `web/lib/api/run-id-param.ts`. They don't use the `runId` parameter alone, because on Vercel Next.js decodes a dynamic route parameter twice (ENG-2166). A run ID of `Q%41`, sent as `Q%2541`, reaches the handler as `QA`. Under `next start` the parameter is decoded once, so local runs and the integration tests can't show this.
- **How it works.** `web/proxy.ts` copies the path as it was sent into the `x-data-hub-raw-path` request header on every request that it passes on, and replaces any value the client sent. `readRunIdParam` finds the run ID after `/instruments/<id>/runs/` in that header and decodes it once. If the header is missing, or has no run ID in it, it returns the parameter.

A new route that has a run ID in its path has to read it the same way.

## Environment variables

Environment-specific configuration is managed through environment variables, never hard-coded. Each component has its own set:

- **Web app** — managed in Vercel, pulled with `vercel env pull`. See [getting started](getting-started.md#web-application).
- **Lambda** — set in the AWS Lambda runtime configuration. See [getting started](getting-started.md#lambda--shared-library).
- **Watcher** — configured via YAML file, not environment variables (except `DATA_HUB_API_KEY` and `DATA_HUB_CONFIG_PATH`).

## Code style

### Python

- Formatter and linter: [Ruff](https://docs.astral.sh/ruff/)
- Type checker: [Pyright](https://github.com/microsoft/pyright)
- Line length: 100
- Quote style: double quotes
- Import sorting: isort-compatible via Ruff, ordered by type
- Lint rules enabled: `B` (bugbear), `E` (pycodestyle errors), `F` (pyflakes), `I` (isort), `UP` (pyupgrade), `W` (pycodestyle warnings)

### TypeScript / JavaScript

- Formatter + linter: [Biome](https://biomejs.dev/) via [Ultracite](https://www.ultracite.ai/) (`npm run lint:check` / `lint:fix`)
- Type checker: TypeScript compiler (`tsc`)

### Pre-commit

Run `make check` before pushing. CI enforces the same checks.

## Testing

Tests are co-located with each package (`lambda/tests/`, `watcher/tests/`,
`web/tests/`); unit tests need no external services, integration tests need
Postgres + a built Next.js server. See [Testing](testing.md) for the full
per-package breakdown, the shared `start_test_server()` fixture pattern, and
how S3 is mocked in Lambda's integration suite.
