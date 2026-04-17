# Adding a new instrument

This guide walks through the end-to-end process of adding a new lab instrument to Data Hub: creating the instrument, installing a watcher, and optionally adding Lambda preprocessing.

## Prerequisites

- A personal access token (see [Managing tokens](managing-tokens.md))
- Access to the instrument PC where files are generated
- Python >= 3.12 and [uv](https://docs.astral.sh/uv/) installed on the instrument PC

## Step 1: Install the watcher on the instrument PC

Follow the [Installing a watcher](installing-a-watcher.md) guide. During `data-hub-watcher init`, choose "Register a new instrument" and provide:

- **Instrument ID** — a kebab-case identifier (e.g., `bio-rad-cfx96`). This becomes the S3 key prefix and the permanent identifier across the system.
- **Display name** — a human-readable name (e.g., "Bio-Rad CFX96"). Defaults to a title-cased version of the ID.

The instrument is created with status `pending`.

## Step 2: Activate the instrument

An admin must confirm the instrument before the watcher can start uploading.

1. Open the Data Hub web app.
2. Navigate to the **Instruments** page.
3. Find the new instrument — it will have a yellow `pending` badge.
4. Click the **Confirm** button next to it.

The instrument status changes to `active` and the watcher can now run.

## Step 3: Start watching

On the instrument PC:

```sh
data-hub-watcher watch
```

The watcher will detect new files, group them into runs, upload them to S3, and report everything to the API. Files become viewable in the web dashboard immediately after upload.

See the [watcher reference](../watcher.md) for details on upload modes, run detection, and configuration options.

## Step 4 (optional): Add Lambda preprocessing

If the new instrument needs automated preprocessing (metadata extraction, image processing, etc.), you'll need to add a processor to the Lambda function. This requires changes to the codebase.

### 4.1 Register the instrument in the shared library

Add the instrument to `packages/shared/src/data_hub_shared/enums.py`:

```python
class Instrument(Enum):
    # ... existing instruments ...
    BIO_RAD_CFX96 = "bio-rad-cfx96"
```

Add a display name mapping in `packages/shared/src/data_hub_shared/constants.py`:

```python
INSTRUMENT_ID_TO_NAME_MAP: dict[str, str] = {
    # ... existing entries ...
    Instrument.BIO_RAD_CFX96.value: "Bio-Rad CFX96",
}
```

### 4.2 Create a processor module

Create a new directory and `process_file.py` under `lambda/src/data_hub_lambda/`:

```
lambda/src/data_hub_lambda/bio_rad_cfx96/
├── __init__.py
└── process_file.py
```

The processor must expose a `process_file` function:

```python
def process_file(run_id: str, filename: str) -> str:
    """Preprocess a file and return the URL to the run in the web dashboard."""
    ...
```

A typical processor:

1. Gets an API client and the S3 bucket from config.
2. Calls `client.ensure_run()` to create or find the run.
3. Calls `client.create_file()` to register the raw file.
4. Downloads the raw file from S3.
5. Performs instrument-specific preprocessing (parsing, metadata extraction, etc.).
6. Optionally uploads processed artifacts (CSV, images) to the S3 processed bucket and registers them via `client.create_file(..., category="processed")`. This is the pattern used by the SpectraMax plate reader (processed CSV) and Azure 600 Gel Doc (contrast-enhanced PNG).
7. Updates the raw file status to `completed`.
8. Returns the web app URL for the run.

See any existing processor (e.g., `lambda/src/data_hub_lambda/azure_cielo_qpcr/process_file.py` for simple metadata extraction, or `lambda/src/data_hub_lambda/spectramax_plate_reader/process_file.py` for the processed-artifact pattern) for complete examples.

### 4.3 Register the dispatch

Add an `elif` branch in the `lambda_handler` function in `lambda/src/data_hub_lambda/handler.py`:

```python
elif instrument_id == Instrument.BIO_RAD_CFX96.value:
    result_url = bio_rad_cfx96.process_file(
        run_id=event_info.run_id,
        filename=event_info.filename,
    )
```

Don't forget to add the import at the top of `handler.py`.

### 4.4 Add tests

Add unit tests in `lambda/tests/` for the new processor. Integration tests will automatically cover the new instrument if it's registered in the shared library.

### 4.5 Configure the S3 trigger

Add a `LambdaConfiguration` entry to the `RawDataBucket` resource's `NotificationConfiguration` in `infra/template.yaml`. Each entry specifies a prefix (the instrument ID) and a suffix (the file extension):

```yaml
- Event: s3:ObjectCreated:*
  Filter:
    S3Key:
      Rules:
        - Name: prefix
          Value: bio-rad-cfx96/
        - Name: suffix
          Value: .csv
  Function: !GetAtt DataHubFunction.Arn
```

The trigger is created automatically on the next `sam deploy` (or when the deploy workflow runs after merge).

## What you get without Lambda

Even without Step 4, you get a fully functional instrument in Data Hub:

- The watcher uploads raw files to S3.
- Runs and files appear in the web dashboard.
- Files are downloadable via pre-signed S3 URLs.
- Watcher health monitoring (heartbeats, events) works in the dashboard.

Lambda preprocessing adds automated metadata extraction and Slack notifications on top of that.
