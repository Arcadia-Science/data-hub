# Lambda

The Data Hub Lambda function preprocesses raw instrument data uploaded to S3. It is triggered by S3 events, runs an instrument-specific preprocessing pipeline, and reports results back through the API and Slack.

## How it works

1. An S3 `PutObject` event triggers the Lambda function.
2. The handler parses the S3 key to extract the instrument ID, run ID, and filename. The expected key layout is `{instrument_id}/{run_id}/{filename}`.
3. It dispatches to the appropriate instrument processor based on the instrument ID.
4. The processor downloads the raw file from S3, preprocesses it (e.g., extracting metadata), and creates/updates the run and files via the Data Hub API.
5. On success, a Slack message is sent with a link to view the run in the web dashboard.
6. On failure, a Slack message is sent with a link to the CloudWatch logs.

## Supported instruments

| Instrument | Module | Instrument ID |
| --- | --- | --- |
| Agilent 4150 TapeStation | `agilent_4150_tapestation` | `agilent-4150-tapestation` |
| Akta FPLC | `akta_fplc` | `akta-fplc` |
| Azure 600 Gel Doc | `azure_600_gel_doc` | `azure-600-gel-doc` |
| Azure Cielo qPCR | `azure_cielo_qpcr` | `azure-cielo-qpcr` |
| SpectraMax iD3 Plate Reader | `spectramax_plate_reader` | `spectramax-id3-plate-reader` |
| SpectraMax iD5 Plate Reader | `spectramax_plate_reader` | `spectramax-id5-plate-reader` |

Each processor module exposes a `process_file()` function that accepts the run ID and filename (and instrument ID for SpectraMax readers) and returns a URL to the run in the web dashboard.

## Adding a new instrument

1. **Register the instrument.** Add a new member to the `Instrument` enum in `packages/shared/src/data_hub_shared/enums.py` and a corresponding entry in the `INSTRUMENT_ID_TO_NAME_MAP` in `packages/shared/src/data_hub_shared/constants.py`.

2. **Create a processor module.** Add a new module under `lambda/src/data_hub_lambda/` (e.g., `new_instrument.py`). It must expose:

   ```python
   def process_file(run_id: str, filename: str) -> str:
       """Process a file and return the URL to the run in the web dashboard."""
       ...
   ```

3. **Register the dispatch.** Add an `elif` branch in the `lambda_handler` function in `lambda/src/data_hub_lambda/handler.py` that maps the new instrument ID to your `process_file` function.

4. **Add tests.** Add unit tests in `lambda/tests/` for the new processor.

## Docker build

The Lambda function is packaged as a container image:

```sh
make docker-build-lambda
```

The Dockerfile is a multi-stage build:

1. **Builder stage**: Uses `uv` to export and install third-party dependencies into the Lambda task root.
2. **Final stage**: Copies the installed dependencies plus the `data_hub_shared` and `data_hub_lambda` source packages.

The entry point is `data_hub_lambda.handler.lambda_handler`.

## Dependencies

The Lambda function depends on a scientific Python stack:

- `pandas` — data manipulation
- `matplotlib` — plotting
- `scikit-image` — image processing
- `tifffile` — TIFF file reading
- `pydantic` — data validation
- `requests` — HTTP client for the Data Hub API
- `aws-lambda-typing` — type stubs for Lambda events/context
- `data-hub-shared` — shared utilities (S3, Slack, enums)
