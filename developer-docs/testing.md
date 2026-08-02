# Testing

Four independent test suites across two frameworks — one per package, plus a
split between fast/isolated tests and tests that exercise a real Postgres +
Next.js server. This page is the map; see [Conventions](conventions.md) for the
one-line summary and [CI and deployment](ci-and-deployment.md) for how these
run in GitHub Actions.

## Running tests

| Command | Package(s) | What it runs |
| --- | --- | --- |
| `make py-test-unit` | `lambda/`, `watcher/` | pytest, excluding `@pytest.mark.integration` — no external services |
| `make py-test-integration` | `lambda/`, `watcher/` | pytest, only `@pytest.mark.integration` — builds/starts Next.js against Postgres |
| `make py-test` | `lambda/`, `watcher/` | All pytest tests (unit + integration) |
| `make fe-test-unit` | `web/` | Vitest `tests/unit/` + `tests/mcp/` — no Postgres, no server |
| `make fe-test-integration` | `web/` | Vitest `tests/integration/` — builds/starts Next.js against Postgres |
| `make fe-test` | `web/` | `fe-test-unit` then `fe-test-integration` |

`packages/shared/` has no tests of its own — it ships `testing.py`, the shared
integration-test infrastructure that `lambda/` and `watcher/` both depend on
(see [below](#the-shared-test-server-start_test_server)).

Integration tests (Python and TypeScript alike) need Postgres reachable at
`127.0.0.1:5432` and create/reuse a `data_hub_test` database. They also build
and start a real Next.js **production** server (`next build && next start`)
rather than `next dev` — dev mode recompiles on every request, which makes a
large suite 5–10x slower, and a production build matches actual deployment
behavior. That build writes to `web/.next`, which **contends with a running
`make dev`** (same directory) — stop the dev server first. See `AGENTS.md` for
this and other local-environment caveats.

## Python (pytest): `lambda/`, `watcher/`

Tests are co-located per package (`lambda/tests/`, `watcher/tests/`), with an
`integration/` subdirectory holding everything marked
`@pytest.mark.integration`. Unit tests should never require Postgres, a running
server, or real AWS credentials.

### The shared test server: `start_test_server()`

Both packages' integration suites depend on
[`data_hub_shared.testing`](shared-library.md) for an identical
environment with minimal boilerplate. The session-scoped pattern, from
`watcher/tests/integration/conftest.py` and `lambda/tests/integration/conftest.py`:

```python
@pytest.fixture(scope="session")
def integration_env() -> Generator[IntegrationEnv, None, None]:
    with start_test_server() as env:
        seed_instruments(env.db_dsn, {...})
        yield env
```

`start_test_server()` creates the `data_hub_test` database if missing, pushes
the Drizzle schema via `npx drizzle-kit push --force`, seeds a deterministic
`watcher_release_config` row, builds and starts `next start` on a free port,
waits for it to respond, seeds a test user + personal access token, and yields
an `IntegrationEnv(base_url, api_token, db_dsn)`. The server is torn down
(`terminate()`, then `kill()` after a 10s grace period) when the `with` block
exits.

Because the server is session-scoped, tests need to reset state between runs
without tearing it down. Both suites do this with an `autouse` fixture that
`truncate_tables()`s only the data tables that change per test — seeded rows
like `instruments` and the PAT stay put so tests don't need to re-seed them:

```python
_DATA_TABLES = ["files", "instrument_runs"]

@pytest.fixture(autouse=True)
def reset_db(integration_env: IntegrationEnv) -> None:
    truncate_tables(integration_env.db_dsn, _DATA_TABLES)
```

### Mocking S3 in Lambda integration tests

`lambda/tests/integration/conftest.py` patches `data_hub_shared.s3_utils`
directly rather than mocking at the boto3 client level, so `process_file()`
implementations run unmodified end-to-end except for the actual network calls:

- `mock_s3_download` (autouse) redirects `download_file()` to copy from a
  `s3_fixture_files: dict[str, Path]` registry that each test populates before
  invoking the handler.
- `mock_s3_upload` (autouse) no-ops `upload_file()` for processors that write
  processed artifacts (e.g. Azure 600 Gel Doc).
- `make_s3_event` / `make_function_url_event` build synthetic S3 event /
  Function URL payloads matching the real key layout
  (`{instrument_id}/{run_id}/{filename}`), including the `quote_plus`
  form-encoding real S3 notifications use.

## TypeScript (Vitest): `web/`

Three test directories, two Vitest configs:

- **`tests/unit/` + `tests/mcp/`** run together under `vitest.unit.config.ts`
  (`npm run test:unit` / `make fe-test-unit`) — pure functions and in-memory MCP
  transport tests. No Postgres, no server, no global setup, 10s timeout.
  `tests/mcp/` is grouped in here (not with `tests/integration/`) because it
  exercises the MCP server's in-memory transport directly against a mocked
  data layer — it's a fast unit-style test, not an HTTP integration test.
  These tests do not exercise the OAuth/JWKS path.
- **`tests/integration/`** runs under `vitest.integration.config.ts`
  (`npm run test:integration` / `make fe-test-integration`) — real HTTP
  requests against a built-and-started Next.js server. `globalSetup` points at
  `tests/integration/global-setup.ts`, and `fileParallelism: false` because
  every test file shares the one Postgres database and server instance.
  MCP HTTP tests that authenticate with a seeded PAT need
  `MCP_ALLOW_PAT_AUTH=true` on the test server (dev/CI only; hard-disabled
  when `VERCEL_ENV=production`). Full OAuth browser flows are out of scope for
  this suite.

`global-setup.ts` mirrors what `start_test_server()` does for Python, plus one
thing the Python side doesn't need: an in-process HTTP server on a free port
that captures outgoing Slack webhook calls (`slack_channel_config` is seeded to
point at it) and Slack Web API `chat.postMessage` calls (DMs), so
notification-related tests can assert on captured payloads without hitting
Slack. It also strips `LAMBDA_FUNCTION_URL` / `AWS_ROLE_ARN` from the spawned
server's environment so "Lambda not configured" code paths are exercised
regardless of the developer's local `.env` — tests that need a stubbed Lambda
call should mock `fetch` instead of relying on a real Function URL. Values that
test files need (`base_url`, `databaseUrl`, capture-server URLs) are passed
back via `process.env`, since Vitest's global setup runs in a separate worker
from the tests themselves.

## In CI

`python-test.yml` runs `make py-test` (unit + integration together, one
Postgres 17 service container). `typescript-test.yml` runs `make fe-test-unit`
then `make fe-test-integration` as separate steps. See
[CI and deployment](ci-and-deployment.md) for the full workflow list.
