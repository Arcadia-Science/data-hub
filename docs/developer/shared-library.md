# Shared library

`data-hub-shared` is a Python package that provides utilities and contracts shared between the Lambda function and the watcher. It lives in `packages/shared/`.

## Modules

### `enums`

Defines the optional `Instrument` enum for watcher/CLI display naming. Lambda dispatch and reprocess eligibility use `instrument_type` on the web app's `instruments` table, not this enum.

```python
from data_hub_shared.enums import Instrument

Instrument.AKTA_FPLC.value  # "akta-fplc"
```

Enum members available for display naming:

| Enum member | Value |
| --- | --- |
| `AGILENT_4150_TAPESTATION` | `agilent-4150-tapestation` |
| `AKTA_FPLC` | `akta-fplc` |
| `AZURE_600_GEL_DOC` | `azure-600-gel-doc` |
| `AZURE_CIELO_QPCR` | `azure-cielo-qpcr` |
| `SPECTRAMAX_ID3_PLATE_READER` | `spectramax-id3-plate-reader` |
| `SPECTRAMAX_ID5_PLATE_READER` | `spectramax-id5-plate-reader` |

### `constants`

Reserved for cross-package constants. Instrument display names live in the web app's `instruments` table; Lambda dispatch uses `instrument_type` rather than a shared ID→name map.

### `config`

Shared environment-based configuration. Instantiated as a module-level singleton `config`:

```python
from data_hub_shared.config import config

config.AWS_S3_RAW_DATA_BUCKET
```

| Attribute | Source env var | Default |
| --- | --- | --- |
| `LOCAL_DATA_DIRPATH` | `LOCAL_DATA_DIRPATH` | `/tmp/data` |
| `AWS_REGION` | `AWS_REGION` | `None` |
| `AWS_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` | `None` |
| `AWS_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` | `None` |
| `AWS_SESSION_TOKEN` | `AWS_SESSION_TOKEN` | `None` |
| `AWS_S3_RAW_DATA_BUCKET` | `AWS_S3_RAW_DATA_BUCKET` | `None` |
| `AWS_S3_PROCESSED_DATA_BUCKET` | `AWS_S3_PROCESSED_DATA_BUCKET` | `None` |

### `s3_utils`

Boto3-based S3 utilities. Callers can pass an explicit `s3_client` or let the module create one from ambient credentials.

| Function | Description |
| --- | --- |
| `get_s3_client()` | Create a boto3 S3 client |
| `parse_s3_uri(uri)` | Split `s3://bucket/key` into `(bucket, key)` |
| `upload_file(local_path, s3_uri)` | Upload a file to S3 (auto-detects content type) |
| `download_file(s3_uri, local_path)` | Download a file from S3 |
| `list_objects(s3_uri_prefix, suffix)` | List object URIs under a prefix |
| `upload_folder(local_path, s3_uri_prefix)` | Upload all files in a directory |
| `get_content_type(file_path)` | Guess MIME type for a file |

### `logger`

Provides a `get_named_logger(name)` helper for consistent logging setup.

### `testing`

Integration test infrastructure used by both Lambda and watcher test suites. Provides:

- **`start_test_server()`** — context manager that creates a test Postgres database, pushes the Drizzle schema, builds and starts a Next.js production server, seeds auth, and yields an `IntegrationEnv`. It works on POSIX and on Windows. The server is `node` running Next.js directly (not through `npx`), listening on `127.0.0.1` only, and it is stopped when the `with` block exits. Postgres settings come from `DATA_HUB_TEST_PGHOST`, `DATA_HUB_TEST_PGPORT`, `DATA_HUB_TEST_PGUSER` and `DATA_HUB_TEST_PGPASSWORD`, and default to `127.0.0.1`, `5432`, `postgres` and `postgres`. The standard `PG*` variables are ignored, so a shell that points `psql` at another server can't send the harness there.
- **`IntegrationEnv`** — frozen dataclass with `base_url`, `api_token`, `db_dsn`, `server_log` (the file the server's output goes to), `s3_mirror_root` (the server's S3 stand-in directory), `cron_secret`, `auth_secret` and `raw_bucket` (the raw-data bucket's name, which is the first folder under `s3_mirror_root`). The log and the S3 directory live in a temp directory made for each session.
- **`AUTH_SECRET`** / **`CRON_SECRET`** — the secrets the test server runs with. `CRON_SECRET` is the bearer token for the cron routes.
- **`seed_auth(dsn)`** — inserts a test user and personal access token, returning the plaintext token.
- **`seed_admin_session(dsn)`** — inserts an admin user and a session, and returns an `AdminSession(user_id, cookie_header)`. `cookie_header` is a signed Better Auth session cookie, ready to send as the `Cookie` header on admin-only routes.
- **`seed_instruments(dsn, instruments)`** — inserts instrument rows.
- **`truncate_tables(dsn, tables)`** — truncates tables with CASCADE.
- **`db_query(dsn, sql)`** / **`db_update(dsn, sql)`** — direct DB access for test assertions and setup.

### `testing_proxy`

`FaultProxy` is a reverse proxy that sits between the watcher and the test server, passes requests through, and lets a test switch on faults such as error responses, delays, dropped connections and an outage, so the test can check how the watcher copes.

### `testing_index`

`LocalPackageIndex` is a small package index that lists the watcher wheels in a folder and sends every other package to the real PyPI, so a test can offer the watcher a newer version to update to without publishing anything.

### `testing_wheels`

`build_watcher_wheel()` builds a wheel of the watcher from this checkout, optionally under a higher version number, so a test has a current build and a newer build to install and update between. Every build runs on a temporary copy of `watcher/`, so it writes nothing into the checkout and can't ship a module that was deleted from `src/` but still sits in an old local `watcher/build`.

The three modules use only the standard library, and `testing_wheels` also runs the `uv` program. Their tests are in `packages/shared/tests/`. The `testing_wheels` tests run `uv build` twice (the tests in that file share the two wheels), so they need `uv` on the PATH, and network access to fetch the build tools when the `uv` cache is cold. A few `testing_index` tests install a package with `uv` from the local index and need `uv` but no network. Tests that need `uv` skip themselves when it isn't on the PATH.

## Dependencies

- `boto3` — AWS SDK for S3 operations
- `psycopg2-binary` — PostgreSQL driver (dev dependency, used by `testing.py`)
