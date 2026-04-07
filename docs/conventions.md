# Conventions

Team agreements and standards for the Data Hub codebase.

## S3 key layout

All raw data files are stored in S3 with the key pattern:

```
{instrument_id}/{run_id}/{filename}
```

- **`instrument_id`** — kebab-case identifier matching the `Instrument` enum (e.g., `akta-fplc`).
- **`run_id`** — unique identifier for the run, either extracted from the filename prefix or from a subdirectory name.
- **`filename`** — the original filename.

The S3 bucket name follows the template `arcadia-raw-data-hub-{environment}`, where `environment` is `staging` or `production`.

## Instrument IDs

Instrument IDs are kebab-case strings (lowercase letters, numbers, hyphens). They serve as:

- S3 key prefixes
- API resource identifiers
- Enum values in `data_hub_shared.enums.Instrument`

When adding a new instrument, the ID must be registered in three places:

1. `Instrument` enum in `packages/shared/src/data_hub_shared/enums.py`
2. `INSTRUMENT_ID_TO_NAME_MAP` in `packages/shared/src/data_hub_shared/constants.py`
3. Dispatch logic in `lambda/src/data_hub_lambda/handler.py`

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

- Formatter: [Prettier](https://prettier.io/)
- Linter: [ESLint](https://eslint.org/)
- Type checker: TypeScript compiler (`tsc`)

### Pre-commit

Run `make check-all` before pushing. CI enforces the same checks.

## Environments

| Environment | API URL | S3 bucket |
| --- | --- | --- |
| Staging | `https://data-hub-env-staging-arcadia-science.vercel.app/api/v1` | `arcadia-raw-data-hub-staging` |
| Production | `https://data-hub.arcadiascience.com/api/v1` | `arcadia-raw-data-hub-production` |

## Testing

- Tests are co-located with each package: `lambda/tests/`, `watcher/tests/`, `packages/shared/tests/`.
- Integration tests are marked with `@pytest.mark.integration` and require Postgres + a running Next.js server.
- The shared `testing.py` module provides the `start_test_server()` context manager that handles all setup and teardown.
- Unit tests should not require any external services.
