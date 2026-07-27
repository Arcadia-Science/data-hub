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

Run `make check-all` before pushing. CI enforces the same checks.

## Testing

Tests are co-located with each package (`lambda/tests/`, `watcher/tests/`,
`web/tests/`); unit tests need no external services, integration tests need
Postgres + a built Next.js server. See [Testing](testing.md) for the full
per-package breakdown, the shared `start_test_server()` fixture pattern, and
how S3 is mocked in Lambda's integration suite.
