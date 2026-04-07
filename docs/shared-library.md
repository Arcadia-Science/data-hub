# Shared library

`data-hub-shared` is a Python package that provides utilities and contracts shared between the Lambda function and the watcher. It lives in `packages/shared/`.

## Modules

### `enums`

Defines the `Instrument` enum, whose kebab-case values are used as S3 key prefixes and as the canonical instrument identifiers throughout the system.

```python
from data_hub_shared.enums import Instrument

Instrument.AKTA_FPLC.value  # "akta-fplc"
```

Currently supported instruments:

| Enum member | Value |
| --- | --- |
| `AGILENT_4150_TAPESTATION` | `agilent-4150-tapestation` |
| `AKTA_FPLC` | `akta-fplc` |
| `AZURE_600_GEL_DOC` | `azure-600-gel-doc` |
| `AZURE_CIELO_QPCR` | `azure-cielo-qpcr` |
| `SPECTRAMAX_ID3_PLATE_READER` | `spectramax-id3-plate-reader` |
| `SPECTRAMAX_ID5_PLATE_READER` | `spectramax-id5-plate-reader` |

### `constants`

Maps between instrument IDs and human-readable display names:

```python
from data_hub_shared.constants import INSTRUMENT_ID_TO_NAME_MAP, INSTRUMENT_NAME_TO_ID_MAP
```

### `config`

Shared environment-based configuration. Instantiated as a module-level singleton `config`:

```python
from data_hub_shared.config import config

config.AWS_S3_RAW_DATA_BUCKET
config.SLACK_WEBHOOK_URL
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
| `SLACK_WEBHOOK_URL` | `SLACK_WEBHOOK_URL` | `None` |

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

### `slack`

Posts messages to a Slack channel via a webhook URL:

```python
from data_hub_shared import slack

slack.send_message("Hello from Data Hub!")
```

If `SLACK_WEBHOOK_URL` is not set, messages are silently skipped with a warning log.

### `logger`

Provides a `get_named_logger(name)` helper for consistent logging setup.

### `testing`

Integration test infrastructure used by both Lambda and watcher test suites. Provides:

- **`start_test_server()`** — context manager that creates a test Postgres database, pushes the Drizzle schema, builds and starts a Next.js production server, seeds auth, and yields an `IntegrationEnv` with the base URL, API token, and DB DSN.
- **`seed_auth(dsn)`** — inserts a test user and personal access token, returning the plaintext token.
- **`seed_instruments(dsn, instruments)`** — inserts instrument rows.
- **`truncate_tables(dsn, tables)`** — truncates tables with CASCADE.
- **`db_query(dsn, sql)`** / **`db_update(dsn, sql)`** — direct DB access for test assertions and setup.

## Dependencies

- `boto3` — AWS SDK for S3 operations
- `requests` — HTTP client for Slack webhooks
- `psycopg2-binary` — PostgreSQL driver (dev dependency, used by `testing.py`)
