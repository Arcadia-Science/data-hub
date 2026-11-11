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

`packages/shared/` ships `testing.py`, the shared integration-test
infrastructure that `lambda/` and `watcher/` both depend on (see
[below](#the-shared-test-server-start_test_server)), and three helper modules
for end-to-end tests of the watcher (see
[below](#helpers-for-end-to-end-watcher-tests)). It has unit tests of its own in
`packages/shared/tests/`, and `make py-test-unit` runs them too. They need
neither Postgres nor a server. The tests for `testing_wheels` run `uv build` twice
(they share the two wheels), so they need `uv` on the PATH, and network access
to fetch the build tools when the `uv` cache is cold. A few tests for `testing_index` install a package with `uv`
and need `uv` but no network. Tests that need `uv` skip themselves when it isn't
on the PATH.

Integration tests (Python and TypeScript alike) need Postgres reachable at
`127.0.0.1:5432` and create/reuse a `data_hub_test` database. The Python
harness can use a different server: set `DATA_HUB_TEST_PGHOST`,
`DATA_HUB_TEST_PGPORT`, `DATA_HUB_TEST_PGUSER` and `DATA_HUB_TEST_PGPASSWORD`
(the defaults are `127.0.0.1`, `5432`, `postgres` and `postgres`).
`DATA_HUB_TEST_PGHOST` must be a host name or address, not a socket directory.
The harness deliberately ignores the standard `PGHOST`, `PGPORT`, `PGUSER` and
`PGPASSWORD`. Your shell may point `psql` at another server, and the harness
creates a database, runs `drizzle-kit push --force` and truncates tables. The
TypeScript suite doesn't read any of these variables. The tests also build
and start a real Next.js **production** server (`next build && next start`)
rather than `next dev` — dev mode recompiles on every request, which makes a
large suite 5–10x slower, and a production build matches actual deployment
behavior. That build writes to `web/.next`, which **contends with a running
`make dev`** (same directory) — stop the dev server first. See
[Local development](local-development.md) for the rest of the local setup.

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
an `IntegrationEnv`. It reads the `DATA_HUB_TEST_PG*` variables when it is
called. It finds `npx` (for `drizzle-kit` and `next build`) and `node` (for the
server) with `shutil.which`, so it works on Windows, where `npx` is `npx.cmd`.
It stops with a clear error if `npx` or `node` is missing, or if Next.js isn't
installed in `web/node_modules` (run `npm ci` in `web/`).

`IntegrationEnv` is a frozen dataclass with these fields:

| Field | What it holds |
| --- | --- |
| `base_url` | The server's origin, for example `http://127.0.0.1:54321`. |
| `api_token` | A personal access token with the `*` scope. |
| `db_dsn` | A DSN for the `data_hub_test` database. |
| `server_log` | The file that receives the server's stdout and stderr. |
| `s3_mirror_root` | The directory the server uses as its S3 stand-in. An object lands at `<s3_mirror_root>/<bucket>/<key>`. |
| `cron_secret` | The bearer token the cron routes accept. |
| `auth_secret` | The `AUTH_SECRET` that signs session cookies. |

`data_hub_shared.testing.AUTH_SECRET` and `CRON_SECRET` hold the same two
secrets as module constants.

**The server log.** The server writes straight to `server.log` in a temp
directory made for this session (named `data-hub-it-…` in your system temp
directory). Nothing reads a pipe, so a long run can't fill one and stall the
server. If the server doesn't start, the error message includes the end of
the log. The temp directory is not deleted when the session ends, so you can
read the log and the S3 stand-in after a failure. Delete it when you no longer
need it.

**The S3 stand-in.** The server runs as production, so its local S3 mirror is
off. The harness sets `INTEGRATION_TEST_S3_MIRROR` to `s3_mirror_root`,
a fresh directory for each session, and sets the multipart threshold and part
size to 1024 bytes. Tests should read objects from `s3_mirror_root` and never
hard-code a path.

**The server environment.** The harness sets `CRON_SECRET`, so a test can call
`/api/cron/upload-queue-sweep` with `Authorization: Bearer <cron_secret>`. It
sets `BETTER_AUTH_URL` to the server's own `http://127.0.0.1:<port>` address, so
the session cookie from `seed_admin_session` has the name the server expects. It
sets `AWS_ROLE_ARN`, `LAMBDA_FUNCTION_URL`, `STALLED_PROCESSING_AFTER_MINUTES`,
`VERCEL` and `VERCEL_PROJECT_PRODUCTION_URL` to empty strings, because a
developer's local value of any of them would change what the tests see. The
S3 stand-in turns itself off when `VERCEL` is set, and an https production URL
changes Better Auth's cookie name. The harness blanks these variables instead
of removing them. `next build` and `next start` read `web/.env`,
`web/.env.local` and the other `web/.env*` files for any variable that is
missing from the process environment, so a removed `VERCEL` would come back from
a `web/.env.local` made by `vercel env pull`. A variable that is set to an empty
string is left alone, and the server treats it as unset. Variables that the
harness doesn't set still come from your `web/.env*` files.

**The server process.** The harness starts the server as `node
web/node_modules/next/dist/bin/next start -H 127.0.0.1 -p <port>`, without
`npx`. `npx` runs the real server as a child of a wrapper process (`cmd.exe` on
Windows), and `taskkill /T` finds children by their parent process, so a
wrapper that exited first would leave the server running. With `node` there is
a single process to stop on both platforms. `drizzle-kit push` and `next build`
still go through `npx`, because they finish before the server starts. The server
listens on `127.0.0.1` only. `next start` listens on every interface by
default, and the S3 stand-in has no authentication, so any machine on your
network could write into it during a run.

**Teardown.** The server runs in its own process group (its own session on
POSIX). When the `with` block exits, the harness stops it. On POSIX it sends
SIGTERM to the process group, waits up to 10 seconds for the server to exit,
then sends SIGKILL to the group. On Windows it runs `taskkill /T /F` on the
server's process id, and kills that process directly if `taskkill` fails.
Teardown doesn't depend on the Windows process group. It kills by process id.

If pytest is killed before the `with` block can exit (a second Ctrl+C, or
SIGKILL), nothing stops the server, and it keeps running on its port. Look for
a `node` process that was started with `next start` and stop it.

**Admin sessions.** Some routes need a signed-in admin, and a personal access
token can't reach them. `seed_admin_session(dsn)` inserts an admin user and a
session that expires in 7 days. It returns an `AdminSession(user_id,
cookie_header)`. Send `cookie_header` as the `Cookie` header. It builds the
value the way `seedSessionCookie` in `web/tests/integration/helpers.ts` does:
`better-auth.session_token=` followed by the URL-encoded token and its
HMAC-SHA256 signature. Pass `auth_secret=` if the server uses a different
secret than the harness.

```python
admin = seed_admin_session(env.db_dsn)
requests.get(
    f"{env.base_url}/api/v1/settings/watcher-release",
    headers={"Cookie": admin.cookie_header},
)
```

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

### Helpers for end-to-end watcher tests

Three more modules in `packages/shared/` help a test run the real watcher
program and break things around it.

- **`testing_proxy`:** `FaultProxy` is a reverse proxy that sits between the
  watcher and the test server, passes requests through, and lets a test switch
  on faults such as error responses, delays, dropped connections and an outage,
  so the test can check how the watcher copes.
- **`testing_index`:** `LocalPackageIndex` is a small package index that lists
  the watcher wheels in a folder and sends every other package to the real PyPI,
  so a test can offer the watcher a newer version to update to without
  publishing anything. The watcher is pointed at it with the test-only
  `DATA_HUB_WATCHER_INDEX_URL` variable, described under
  [Test-only overrides](watcher.md#test-only-overrides).
- **`testing_wheels`:** `build_watcher_wheel()` builds a wheel of the watcher
  from this checkout, optionally under a higher version number, so a test has a
  current build and a newer build to install and update between. Every build
  runs on a temporary copy of `watcher/`, so it writes nothing into the
  checkout (no `watcher/build` or `*.egg-info`) and can't ship a module that
  was deleted from `src/` but still sits in an old local `watcher/build`.

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
  MCP HTTP tests sign in with the `getMcpAccessToken(userId, scope)` helper in
  `tests/integration/helpers.ts`. It inserts the OAuth client row directly
  (dynamic registration is limited to about 5 requests a minute per IP), then
  runs authorize → consent → token for real using a DB-seeded session cookie,
  and returns a JWT access token. MCP accepts JWT access tokens only (clients
  pass RFC 8707 `resource`) and rejects personal access tokens. Authorize,
  consent, and token are also rate limited per IP, so call the helper once per
  user in `beforeAll`, not per test. `mcp-oauth.test.ts` is the place that
  covers discovery, real client registration, and the consent screen.

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
