# Testing

Four independent test suites across two frameworks — one per package, plus a
split between fast/isolated tests and tests that exercise a real Postgres +
Next.js server, and a separate end-to-end suite that runs the real watcher. This page is the map; see [Conventions](conventions.md) for the
one-line summary and [CI and deployment](ci-and-deployment.md) for how these
run in GitHub Actions.

## Running tests

| Command | Package(s) | What it runs |
| --- | --- | --- |
| `make py-test-unit` | `lambda/`, `watcher/`, `packages/shared/` | pytest, excluding `@pytest.mark.integration` — no Postgres or server. The wheel-build tests in `packages/shared/` need `uv` on the PATH, and network access when the `uv` cache is cold |
| `make py-test-integration` | `lambda/`, `watcher/` | pytest, only `@pytest.mark.integration` — builds/starts Next.js against Postgres |
| `make py-test` | `lambda/`, `watcher/`, `packages/shared/` | All pytest tests (unit + integration) |
| `make py-test-e2e` | `watcher/e2e/` | The [end-to-end suite](#end-to-end-tests-of-the-watcher): the real watcher against the test server. Not part of `py-test`, and not run in pull requests |
| `make fe-test-unit` | `web/` | Vitest `tests/unit/` + `tests/mcp/` — no Postgres, no server |
| `make fe-test-integration` | `web/` | Vitest `tests/integration/` — builds/starts Next.js against Postgres |
| `make fe-test` | `web/` | `fe-test-unit` then `fe-test-integration` |

`packages/shared/` ships `testing.py`, the shared integration-test
infrastructure that `lambda/` and `watcher/` both depend on (see
[below](#the-shared-test-server-start_test_server)), and three helper modules
for end-to-end tests of the watcher (see
[below](#helpers-for-end-to-end-watcher-tests)). It has unit tests of its own in
`packages/shared/tests/`, and `make py-test-unit` runs them too. They need
neither Postgres nor a server. The tests for `testing_wheels` run `uv build`
twice (the tests in that file share the two wheels), so they need `uv` on the
PATH, and network access to fetch the build tools when the `uv` cache is cold.
A few tests for `testing_index` install a package with `uv` and need `uv` but no
network. Tests that need `uv` skip themselves when it isn't on the PATH.

Integration tests (Python and TypeScript alike) need Postgres reachable at
`127.0.0.1:5432` and create/reuse a `data_hub_test` database. The Python
harness can use a different server or database: set `DATA_HUB_TEST_PGHOST`,
`DATA_HUB_TEST_PGPORT`, `DATA_HUB_TEST_PGUSER`, `DATA_HUB_TEST_PGPASSWORD` and
`DATA_HUB_TEST_PGDATABASE` (the defaults are `127.0.0.1`, `5432`, `postgres`,
`postgres` and `data_hub_test`). The harness creates the database if it is
missing, so two runs that must not share tables, such as the integration suite
and the [end-to-end suite](#end-to-end-tests-of-the-watcher), can each use their
own by setting `DATA_HUB_TEST_PGDATABASE`. Its value must be a plain name:
letters, digits and underscores, not starting with a digit, at most 63
characters. `DATA_HUB_TEST_PGHOST` must be a host name or address, not a socket
directory. The harness deliberately ignores the standard `PGHOST`, `PGPORT`,
`PGUSER`, `PGPASSWORD` and `PGDATABASE`. Your shell may point `psql` at another
server, and the harness creates a database, runs `drizzle-kit push --force` and
truncates tables. The TypeScript suite doesn't read any of these variables. The
tests also build and start a real Next.js **production** server (`next build && next start`)
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

`start_test_server()` creates the test database (`data_hub_test` unless
`DATA_HUB_TEST_PGDATABASE` says otherwise) if missing, pushes
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
| `db_dsn` | A DSN for the test database. |
| `server_log` | The file that receives the server's stdout and stderr. |
| `s3_mirror_root` | The directory the server uses as its S3 stand-in. An object lands at `<s3_mirror_root>/<bucket>/<key>`. |
| `cron_secret` | The bearer token the cron routes accept. |
| `auth_secret` | The `AUTH_SECRET` that signs session cookies. |
| `raw_bucket` | The name of the raw-data bucket the server uses. It is the first folder under `s3_mirror_root`. |

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
size to 1024 bytes. Tests should read objects from `s3_mirror_root / raw_bucket` and never
hard-code a path or a bucket name.

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
SIGKILL), nothing stops the server, and it keeps running on its port. On macOS,
`ps` lists it as `next-server (v<version>)`, which is the name Next.js gives the
process. On Windows it is a `node.exe` process with `next start` in its command
line. Stop it by hand.

**Admin sessions.** Some routes need a signed-in admin, and a personal access
token can't reach them. `seed_admin_session(dsn)` inserts an admin user and a
session that expires in 7 days. It returns an `AdminSession(user_id,
cookie_header)`. Send `cookie_header` as the `Cookie` header. It builds the
value the way `seedSessionCookie` in `web/tests/integration/helpers.ts` does:
`better-auth.session_token=` followed by the URL-encoded token and its
HMAC-SHA256 signature. Pass `auth_secret=` if the server uses a different
secret than the harness. `watcher/tests/integration/test_harness_auth.py` sends
the cookie, and the cron secret, to the real server.

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
  so the test can check how the watcher copes. It forwards requests unchanged
  and keeps a log of them, including their headers and any body up to 64 KiB
  (`MAX_RECORDED_BODY_BYTES`), for the test to read.
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
Slack. It also sets `LAMBDA_FUNCTION_URL`, `AWS_ROLE_ARN`,
`STALLED_PROCESSING_AFTER_MINUTES` and `PROCESSING_CONCURRENCY_LIMIT` to empty
strings in the spawned server's environment, so "Lambda not configured" code
paths are exercised regardless of the developer's local `.env` (Next.js only
fills in variables that are missing, so an empty value can't be refilled from
`web/.env.local`).

Tests that need a Lambda call to happen use a second server. Global setup
starts it from the same build with `LAMBDA_FUNCTION_URL` pointed at an
in-process stub that records the S3 location of each invocation and answers
`200` at once. A test can make the stub answer a chosen file with another HTTP
status, after a delay, or by closing the connection (`setLambdaResponse`).
Test files cannot mock the `fetch` that the server makes, because it runs in
another process. `lambdaApi`, `waitForLambdaInvocations`,
`settleLambdaInvocations`, and `waitForLambdaQuiet` in
`tests/integration/helpers.ts` talk to that server and the stub.
`reprocess-queue.test.ts` uses them. The server sends its Lambda calls after
the response, so a test that starts a dispatch waits for the calls it expects,
and its `afterEach` waits for the stub to go quiet before the next test clears
the record. If the second server fails to start, global setup stops the first
server and the stub before it throws. Both servers share one database, and
both have an empty `PROCESSING_CONCURRENCY_LIMIT`, so the queue tests run
against the default limit of 10. Values that
test files need (`base_url`, `databaseUrl`, capture-server URLs) are passed
back via `process.env`, since Vitest's global setup runs in a separate worker
from the tests themselves.

## End-to-end tests of the watcher

The integration tests call the watcher's API client against a real server, but nothing in
them runs the watcher program. The end-to-end suite in `watcher/e2e/` does. It installs a
wheel of the watcher with `uv tool install --python 3.12`, starts `data-hub-watcher watch` as
a real process with its own `HOME` (or, on Windows, installs and starts the real Windows service),
and drives it from outside: files in the watch folder, signals, admin actions on the server, and
network faults. Then it checks what the server and
the S3 stand-in hold. A file is done when its row says `uploaded` and its bytes in the stand-in
match the original. Lambda, Slack and the web UI are outside the suite.

### Running it

```sh
make py-test-e2e
```

It needs what the integration tests need (Postgres on `127.0.0.1:5432`, Node.js, `npm ci`
in `web/`) and `uv` on the PATH. The first run downloads Python 3.12 and the watcher's
dependencies if `uv` doesn't have them. Like the integration tests it builds into `web/.next`,
so stop `make dev` first. `make py-test`, `make py-test-unit` and `make py-test-integration`
never collect it, and the only thing that keeps it out is that `watcher/e2e` is not in pytest's
`testpaths`. (The `e2e` marker that every test module there sets is what `make py-test-e2e`
selects with and what the catalog check requires. It doesn't exclude anything from the other
targets.) Run part of it with the usual pytest selection:

```sh
uv run pytest watcher/e2e/test_smoke.py -m e2e -v -k graceful
```

These variables change a run:

| Variable | Effect |
| --- | --- |
| `DATA_HUB_TEST_PGHOST`, `_PGPORT`, `_PGUSER`, `_PGPASSWORD`, `_PGDATABASE` | Which Postgres and which database the test server uses (see [above](#running-tests)). Set `DATA_HUB_TEST_PGDATABASE` to give a run its own database next to the integration tests or another checkout's e2e run. Two runs in one checkout still share `web/.next` |
| `DATA_HUB_E2E_ARTIFACTS` | Where the files of a failed test go. Default: a folder named `data-hub-e2e-artifacts-<pid>` in your system temp directory. The path is printed in the pytest header and when a test fails |
| `DATA_HUB_E2E_WHEEL` | A prebuilt watcher wheel, or a folder holding exactly one, to install instead of building one from the checkout. The release workflow sets it to the wheel it is about to publish |
| `DATA_HUB_E2E_DRIVER` | The kind of [driver](#drivers) the run uses: `cli` (the default, a `data-hub-watcher watch` process) or `service` (the Windows service: [Running the service suite](#running-the-service-suite)). `service` stops the run with a clear message anywhere but an elevated Windows shell |

The suite starts the watcher without anything from your shell that would change what it does:
every `DATA_HUB_*` variable, the interpreter and index variables of `uv` and `pip`
(`UV_PYTHON`, `UV_INDEX*`, `UV_EXTRA_INDEX_URL`, `UV_DEFAULT_INDEX`, `PIP_*`) and the proxy
variables in any case. It sets `NO_PROXY=127.0.0.1,localhost`. A machine that can reach PyPI only
through a proxy can't run the suite.

### Running the service suite

```powershell
$env:DATA_HUB_E2E_DRIVER = "service"
uv run pytest watcher/e2e -m e2e
```

The same scenario files run against the real Windows service, plus `test_windows_service.py`, which
covers what only a service has: how it is registered, what the Service Control Manager does when it
fails, the scheduled-task worker that upgrades it, and uninstalling it. It needs:

- **Windows, in an elevated shell** (Run as Administrator), because the suite installs, starts and
  removes the `DataHubWatcher` service, and the upgrade worker's scheduled task. The service is
  one per machine, so nothing else may use it while the suite runs, and a service left by an
  earlier run is removed when the next test installs its own. Each test removes its service when
  it ends.
- What the CLI suite needs: Postgres (on `127.0.0.1:5432` unless the `DATA_HUB_TEST_PG*` variables
  say otherwise, see [above](#running-tests)), Node.js with `npm ci` in `web/`, and `uv` on the
  PATH.
- Nothing installed for the real user: the driver installs the wheel (with the `windows-service`
  extra, for pywin32) into a `uv tool` folder of the suite's own, so a `data-hub-watcher` you use
  is left alone. Each test gets a profile folder that stands in for the operator's home
  (`USERPROFILE`), so `~/.data-hub` (the config, the env file, the state database, the upgrade
  worker's files) is that test's. The one shared thing is
  `C:\ProgramData\DataHubWatcher\watcher.log`: the driver reads it from the byte offset where it
  ended when the test began, and never truncates it.

Some of it takes real time. The SCM restarts a service that failed 60 seconds after the first
failure and 120 seconds after the second, so the tests of recovery wait for those, and every upgrade
runs the worker's `uv tool install` as `LocalSystem`, which has its own uv cache. Only three tests
wait for the SCM's real restarts: a killed service, a refused start (the API is unreachable), and
the third failure that leaves the service stopped (a kill, then two refused starts, to show that a
crash and a `SystemExit(1)` count as one service's failures). The other start-up refusals end in the
same `SystemExit(1)`, so they are shown by their log line and a failure exit code. The suite sets
the SCM's recovery actions to none right after `service install`, so a test that kills or refuses
the service sees it stay down as a `watch` process does. Where a test only has to see that the SCM
does not restart a service, it gives it a 2-second restart instead of waiting for 60. A test of
recovery asks for what the product configures with `install_service(failure_actions="product")`.

CI splits the service run over three runners that run at the same time, because one would need
longer than its step allows (see [CI and deployment](ci-and-deployment.md#watcher-end-to-end-tests-watcher-e2eyml)).
To run one shard, pass its files: `uv run pytest watcher/e2e/test_windows_service.py -m e2e`, or
the rest of the suite with `--ignore` for the files of the other two.

### How a test is built

Test modules can't import their siblings (pytest runs with `--import-mode=importlib`), so the
shared code is the package `watcher/e2e/e2e_support/`, which pytest finds through the
`pythonpath` setting in the root `pyproject.toml`. Pyright and Ruff know about it too.

| Module | What it is for |
| --- | --- |
| `drivers` | `WatcherDriver`, the only way a test starts, stops, kills or inspects the watcher. `CliDriver` runs the process on POSIX. See [Drivers](#drivers) |
| `service_driver`, `windows_scm` | `WindowsServiceDriver`, which installs and drives the real Windows service, and the commands it runs (`sc.exe`, `reg.exe`, `schtasks.exe`, PowerShell for the Event Log) with the parsing of what they print. They import on any platform, and `watcher/tests/test_e2e_service_driver.py` tests them with a fake machine |
| `server` | `ServerView`: the watcher row, the status the web app shows (`stale` included) and the watcher list route's rows (`list_watchers`), events, heartbeats, files, runs and their derived status, helpers that make a timestamp old, and the S3 stand-in's objects. It has `wait_for_*` methods that fail with a dump of the server's state |
| `admin` | `Admin`: the actions of a person in the web app, through the real routes. Request upload, delete and restore a run, dismiss a file, change an instrument's status, deregister a watcher, save a config revision, set the release, revoke a token, run the cron sweep |
| `waiting` | `wait_until`, the deadline poll behind every wait, and `stays_true` for "this must not happen". Tests never sleep for a fixed time. A timeout shows the last value seen. `known_bug()` and `KnownBugStillPresent` are for [tests of known bugs](#the-transition-catalog) |
| `proxy_helpers` | What several scenario files do with the fault proxy. `silence_heartbeats` keeps a watcher's heartbeats from reaching the server, so a killed watcher's last heartbeat can be aged without one still on its way refreshing it. `wait_for_answer` waits until the proxy has noted the server's answer to a request. A test needs it before it reads `upstream_status` right after waiting for the server's state, because the server stores a file before it answers. `stopped_heartbeats` returns the bodies of the `stopped` heartbeats the watcher sent. A test reads the `status_reason` of an old process's final heartbeat there, because the server clears the reason on the watcher's row when the watcher heartbeats again |
| `platforms` | Which kind of driver a `@pytest.mark.platforms(...)` test is for, and when a run skips it |
| `files` | Write run folders, files of an exact size on each side of the 1 KB multipart threshold, and a file that keeps growing |
| `factory`, `artifacts` | The `watcher` fixture's factory and the failure artifacts |
| `catalog` | The transition catalog and its check (below) |

`watcher/e2e/conftest.py` provides:

| Fixture | What a test gets |
| --- | --- |
| `integration_env` (session) | The real Next.js server on Postgres, from `start_test_server()` |
| `admin` (session) | An `Admin`. Before each test the release's latest version is set to the current watcher version, so nothing is offered an update unless the test asks |
| `current_wheel`, `current_version` (session) | The wheel under test, built from the checkout or `DATA_HUB_E2E_WHEEL`, and its version |
| `bumped_wheel`, `bumped_version` (session) | The same code under a higher version (the patch number plus 1000), built when first requested. It is what a self-update installs |
| `driver_class` (session) | The class of driver for this run, from `DATA_HUB_E2E_DRIVER` |
| `tool_install` (session) | The shared `uv tool install` of the current wheel, with the extras the driver needs (`windows-service` for the service). Its path contains `/uv/tools/data-hub-watcher`, which is how the watcher knows it is a uv-tool install. A test never asks for it: the `watcher` fixture hands it to the driver |
| `private_install` | What `watcher(own_install=True)` uses to install the watcher for one PC alone. A watcher that updates itself reinstalls into the folder it runs from, so a test that updates asks the factory for its own install. A test doesn't use this fixture, because that would tie it to one kind of driver |
| `package_index` | A local package index that serves the wheels in the suite's wheel folder (the current wheel, and the bumped one once a test has asked for `bumped_wheel`). Pass `package_index.url` to `watcher(index_url=...)`. Each test starts with an empty request log and no failure switches |
| `unreadable_folder` | A folder this user can't list, for the one scenario about an unreadable watch folder. Where the user can list it anyway (root) it skips the test on your machine and fails it on CI, so the scenario can't go untested without anybody noticing |
| `unreadable_file` | A function that takes every permission off a file, so the watcher can see it but can't open it: `unreadable_file(path)`. It stands in, on Linux and macOS, for a file that an instrument keeps open with exclusive sharing on Windows. `make_readable(path)` from `e2e_support.files` gives the permissions back, and the fixture restores any it still holds when the test ends. Where the user can read such a file anyway (root) it skips the test on your machine and fails it on CI, as `unreadable_folder` does |
| `instrument_id` | A fresh instrument, the only one in the database. The watcher tables and instruments are emptied before every test |
| `proxy` | A fresh `FaultProxy` between the watcher and the server, with no faults. The watcher's `api_base_url` points at it, and so do the upload URLs |
| `server` | A `ServerView` |
| `watch_dir` | An empty watch folder |
| `watcher` | A factory for configured drivers. `watcher()` returns a `WatcherDriver` and writes `config.yaml` with the watcher's own `save_config`, writes the env file with the API key and the test timers, and registers the watcher with the server, so `driver.watcher_id` is set. It doesn't start it. Everything about the config and the environment variables can be overridden per test. `watcher(own_install=True)` gives the PC an install of its own (with `wheel=` to install another wheel, such as `bumped_wheel`) for a test that updates the watcher, and `watcher(configure=False)` returns a bare PC for a test that runs `init` |

### Drivers

A test asks the driver and never sends a signal itself. `watcher()` returns a `WatcherDriver`,
the same interface for every kind of driver, and a type checker refuses anything only one kind
has. There are two kinds, named `"cli"` and `"service"` (`driver.kind`), and a run uses one of
them (`DATA_HUB_E2E_DRIVER`). `CliDriver` runs `data-hub-watcher watch` as a process, on Linux
and on macOS. `WindowsServiceDriver` runs the same scenario files with the watcher as the real
Windows service, and `drivers.py` and `service_driver.py` explain how each method maps to Windows.

What a driver offers:

- **The process:** `start`, `stop` (graceful, returns the exit code), `request_stop`,
  `interrupt`, `kill`, `wait_exit`, `restart`, `is_running`, `pid` (`None` when it isn't
  running; compare two readings to see that it is the same process), `exit_code`, and
  `close`. `start()` waits until the watcher is ready to be stopped, because its signal handlers
  are installed only after the start-up scan. `start()` and `run_cli()` take `global_args=` for
  the options that go before the command (`--verbose`, `--config <path>`).
- **After an update:** `await_upgrade_restart(timeout)` carries an update from "the new version
  is being installed" to "the watcher is running again", and `installed_version()` reads the
  version that is installed. Under the CLI the process exits with code 1 once the install is
  done and the driver starts it again. Under the service, the in-process updater doesn't install:
  it hands the upgrade to a scheduled-task worker that runs `Stop-Service`, `uv tool install` and
  `Start-Service`, so the service stops cleanly (exit code 0, a `Service stopped` event, never exit
  code 1 and never "restarting for auto-update") and a new process starts. A scenario that checks
  the exit code or the "restarting for auto-update" event is marked `platforms("cli")`. A scenario
  that waits for an install reads how long from `driver.install_timeout_seconds` (180 s, 300 s under
  the service, whose worker runs `uv` as `LocalSystem` with a cold cache) and keeps no constant of
  its own. A scenario about the upgrade compares its events with a repeat counted once, so it
  doesn't depend on how many times an event was announced. `service.upgrade->worker_dispatch_once`
  is the one that counts them.
  `install_wheel(wheel)` puts another version in place of the installed one while the watcher is
  stopped (the PC must have an install of its own), for the scenario of an update that did not
  take effect: the new version was installed, and the old one is back at the next start.
- **What the watcher says:** it names itself by role, so a test uses `started_prefix`
  (`Watcher started on ` or `Service started on `), `resumed_prefix`, `restarted_prefix`,
  `operator_stop_message` (`Watcher stopped by user`, or `Service stopped`) and
  `update_stop_message` (`Watcher restarting for auto-update`, or `Service stopped`), and never
  the literal text.
- **One-shot commands and setup:** `run_cli` for a command that runs to its end,
  `init_interactive` for the real `init --show-key` with piped answers, `write_config` and
  `write_env`, `hide_uv()` (the watcher can't find `uv`, so an update fails before it starts).
- **The log:** `log_text(since=None)` is what the watcher logged, each line once and the runs in
  order. `mark_logs()` gives a `LogMark` that `log_text(since=mark)` and `wait_for_log(regex,
  timeout, since=mark)` read from. Never count lines in `log_files()`, which are the files for
  the failure artifacts and repeat each other (the CLI logs to the console and to `watcher.log`).
- **The state database:** `state_query` for a SELECT, `state_execute` for a write, and two
  switches for the watcher's own database: `stall_writes(table)` makes its next insert into the
  table take minutes (a watcher stuck inside it is killed when the block ends, and the trigger is
  always dropped) and `fail_writes(table, message)` makes inserts fail and roll back their
  transaction. `wait_for_state_db_busy(hold_seconds)` waits until another process has held the
  database's write lock for that long without a break, which is how a scenario knows the watcher
  is stuck inside a stalled write without depending on which of its writes share a transaction.
  A test never opens the database itself.

Nothing supervises a watcher that runs as a CLI process. After an update it exits with code 1 and
stays down, and `await_upgrade_restart` is the driver standing in for a supervisor and starting
it again.

**The service driver.** `WindowsServiceDriver` does what an operator does, from an elevated shell:
`uv tool install "data-hub-watcher[windows-service]"`, `init` (through `run_cli`, in the PC's
profile folder), `data-hub-watcher service install --env-path <the PC's env file>` and `service
start`. The service is installed the first time the driver starts it, because `service install`
reads the config and a scenario may write it after the PC is built. Under the hood:

- `start()` waits for the line the service logs when it has finished starting (`Data Hub Watcher is
  running`, or `is waiting`), because the SCM reports `RUNNING` as soon as the process is up.
  `wait_exit()` and `kill()` (`taskkill /F /T /PID`) read the SCM's state with `sc queryex`, and
  `exit_code` is its win32 exit code: 0 after a clean stop, 1067 after a kill, and 536870913
  (0x20000001) for anything raised out of the service, a `SystemExit(1)` and an uncaught error alike
  (pywin32 catches what leaves `SvcRun`). It is never the 1 of the `SystemExit`.
- There is one service per machine. A driver that installs takes it over from whichever driver had
  it, and `close()` removes it only if the driver is still the owner. A driver that no longer owns
  the service reports it as not running, and `request_stop()`, `kill()` and `wait_exit()` raise, so
  a test can't stop another PC's service. A test with several PCs starts them one after the other.
- `close()` (and the next install) removes the service in this order: the recovery actions off, so
  that nothing killed comes back; the upgrade task ended and deleted, and any worker still running
  killed, because a worker's last step is `Start-Service`; the stop, a kill if the service won't
  stop (`sc stop` answers 1061 while it is stopping and 1052 while it is starting, and does nothing,
  so the driver waits for those); `service uninstall`; and a wait until the SCM has forgotten the
  service.
- `service install` configures restarts after 60 s and 120 s. The driver turns them off right after
  (`sc failure DataHubWatcher reset= 0 actions= ""`), so that a scenario which kills the watcher or
  refuses its start sees it stay down. `install_service(failure_actions="product")` keeps them.
- The env file gets a `PATH` that leads to `uv` (a service has no user PATH, and the updater needs
  it). `hide_uv()` replaces it with `System32`.
- The log text is `watcher.log` (machine-wide, read from an offset), `service-bootstrap.log`, the
  worker's `upgrade-worker.log` and, after a failed run, the one Event Log entry pywin32 writes when
  the service fails (`The instance's SvcRun() method failed`, with the traceback). The service's own
  log lines reach the Event Log as well, but `watcher.log` has them, so they aren't copied again.
  `log_files()` adds the worker's script and the upgrade sentinels and an export of the service's
  Event Log entries for the failure artifacts.
- `interrupt()` raises `NotImplementedError`, and `start()` refuses `args` and `global_args`: a
  service has no Ctrl+C and takes no options.

### Marking a test for one kind of driver

A test in a shared file runs under both kinds of driver. One that only makes sense for one is
marked, and `conftest.py` skips it under the other kind before any fixture is set up:

```python
@pytest.mark.platforms("cli")  # Ctrl+C: the service has none
@pytest.mark.covers("process.interrupt->clean_exit")
def test_an_interrupt_stops_the_watcher(...): ...
```

The catalog check reads the marker, so it knows which transitions each kind covers, and it
refuses the other ways of skipping a test, which would hide it from the check (see
[the catalog](#the-transition-catalog)). A skip that depends on the machine is a fixture in
`conftest.py` (`unreadable_folder`, `unreadable_file`).

### The overrides it sets

The watcher's timers are minutes long, so the suite shrinks them with the [test-only
overrides](watcher.md#test-only-overrides), written to the env file the watcher loads
(`~/.data-hub/.env.<environment>` under the test's `HOME`): a heartbeat and a queue poll every
2 seconds, an update check every 5th heartbeat, and 2 quiet heartbeats before an idle-gated
update. A self-update scenario adds `DATA_HUB_WATCHER_INDEX_URL`, pointing at the local index.
Server timers are not waited for: `ServerView.age_heartbeat` moves `last_heartbeat_at` into
the past to cross the 5-minute stale mark and the 15-minute sweep grace.

### The transition catalog

The watcher and the server routes it calls are small state machines. `e2e_support/catalog/`
lists every transition once, with an ID such as `file.pending->stable`, in one module per
machine (`setup_startup`, `detection`, `upload_auto`, `upload_queue`, `heartbeat_status`,
`events`, `registration_tokens`, `config_sync`, `shutdown`, `self_update`,
`windows_service`). Each transition has a status:

- `covered`: a test shows it.
- `xfail_bug`: a known gap. The test asserts the intended behavior, so it fails today and fails
  loudly when the bug is fixed, which is when the mark comes off and the status becomes
  `covered`.
- `excluded`: not tested here, with the reason and where it is tested instead.

A test claims transitions with `@pytest.mark.covers("file.pending->stable", ...)`, on a function or
a class. `watcher/tests/test_e2e_catalog.py` reads `watcher/e2e/test_*.py` with `ast` (nothing is
imported or run), so it is fast and runs in `make py-test-unit` and in pull requests. It fails
when a test names an ID that isn't in the catalog, when a transition that isn't excluded has no
test, when an `xfail_bug` transition has no strict xfail test or a `covered` one is covered
only by xfail tests, and when an excluded transition has a test.

**Kinds of driver.** A transition exists for the kinds of driver in its `platforms` (`cli`,
`service`). A test in a shared file runs under both unless `@pytest.mark.platforms("cli")` (or
`"service"`) narrows it, and tests in `test_windows_service.py` run only under the service. The
check fails when a test runs under a kind where a transition it covers doesn't exist, and a
transition that exists for both kinds needs a test that runs under both. Transitions that exist
only under the service (the `windows_service` machine) are covered by `test_windows_service.py`, and
the check asks for a test for each.

**Tests of known bugs.** They all look the same, so a broken precondition can't hide as the
bug:

```python
@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason="bug-example: what goes wrong today",
)
@pytest.mark.covers("machine.thing->intended_outcome")
def test_the_intended_behavior(...):
    ...  # The precondition: everything that must hold before the bug can show.
    with known_bug():
        assert the_intended_behavior()
```

`known_bug()` turns an `AssertionError` raised inside it (a `WaitTimeout` too) into
`KnownBugStillPresent`, which the `xfail` lists in `raises=`. Anything that fails outside the
block is a different failure, so the test fails and doesn't count as the bug. Put only the
assertion that shows the intended behavior inside. The check enforces the pattern: the xfail is
strict and has `raises=KnownBugStillPresent`, the test has a `with known_bug():` block and names
only `xfail_bug` transitions, its reason starts with the bug of one of them (its Linear issue, such
as `ENG-0000:`, or a short slug until the issue is filed), and
no other test names an `xfail_bug` transition. To see that a test fails inside the block, run it
with `--runxfail`.

**Nothing hides a test from the check.** A test file may not contain `pytest.skip(...)`,
`pytest.xfail(...)`, `pytest.importorskip(...)`, the `skip` and `skipif` marks,
`pytest.param(..., marks=...)`, an `xfail` with a condition, or a mark the check can't read (a
decorator that isn't `pytest.mark.<name>`, or a mark kept in a variable). Marks that appear at
several levels follow pytest: for `xfail` and `platforms` the closest wins (function, then class,
then module), and `covers` adds up.

To see what is missing while you write scenarios, run
`cd watcher/e2e && uv run python -m e2e_support.catalog.check --summary`.

### When a test fails

The files that explain it are copied to `$DATA_HUB_E2E_ARTIFACTS/<test id>/`: the part of the
server log written during the test, each watcher's logs with its stdout and stderr, its state
database, `config.yaml`, the server's view of the watcher when the test failed, the fault
proxy's request log, and a listing of the S3 stand-in. Under the service a watcher's files are
`watcher.log` (the whole machine's), `service-bootstrap.log`, `upgrade-worker.log` and
`event-log.txt`, an export of the Windows Event Log entries about the service. A run that is interrupted (Ctrl+C, or CI
cancelling the job) keeps the files of the test that was running. In CI the folder is uploaded as
the `watcher-e2e-linux-artifacts` artifact, for a failed or a cancelled run.

### Why it isn't in pull-request CI

Every test starts a real watcher and some wait for a restart or an update, so the suite is
much slower than the rest. It runs where a regression would otherwise reach lab PCs: on
every push to `production`, by hand with `workflow_dispatch` on any branch, and as a
required job of the release workflow before a wheel is published. Pull requests get the
catalog check, which is fast. See [CI and deployment](ci-and-deployment.md#watcher-end-to-end-tests-watcher-e2eyml).

## In CI

`python-test.yml` runs `make py-test` (unit + integration together, one
Postgres 17 service container). `typescript-test.yml` runs `make fe-test-unit`
then `make fe-test-integration` as separate steps. `watcher-e2e.yml` runs
`make py-test-e2e`, on pushes to `production`, on demand, and before a watcher
release is published. See [CI and deployment](ci-and-deployment.md) for the full
workflow list.
