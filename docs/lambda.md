# Lambda

The Data Hub Lambda function preprocesses raw instrument data uploaded to S3. It can be triggered automatically by S3 events or manually via the web app for reprocessing. It runs an instrument-specific preprocessing pipeline and reports results back through the API and Slack.

## How it works

The Lambda has two invocation paths that converge on the same processing logic:

### S3 trigger (automatic)

1. An S3 `PutObject` event triggers the Lambda function.
2. The handler parses the S3 key to extract the instrument ID, run ID, and filename. The expected key layout is `{instrument_id}/{run_id}/{filename}`.
3. It dispatches to the appropriate instrument processor based on the instrument ID.
4. The processor downloads the raw file from S3, preprocesses it (e.g., extracting metadata), and creates/updates the run and files via the Data Hub API.
5. On success, a Slack message is sent with a link to view the run in the web dashboard.
6. On failure, a Slack message is sent with a link to the CloudWatch logs.

### Function URL (manual reprocessing)

When a file fails processing (or needs to be re-run), users can trigger reprocessing from the run detail page in the web app. This invokes the Lambda's Function URL instead of going through S3:

1. The user clicks **Reprocess** on a failed or completed file in the web dashboard.
2. The web app's `POST /api/v1/files/:fileId/reprocess` endpoint transitions the file to `processing` status, clears any previous error and report data, and sends a POST request to the Lambda Function URL.
3. The request includes an `Authorization: Bearer <LAMBDA_INVOKE_TOKEN>` header and a JSON body containing a synthetic S3 event payload.
4. The Lambda handler detects the Function URL invocation (via `requestContext` in the event), verifies the Bearer token against the `LAMBDA_INVOKE_TOKEN` environment variable using constant-time comparison, and parses the S3 event from the request body.
5. From here, processing follows the same dispatch logic as the S3 trigger path (steps 2–6 above).

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

## Local processing CLI

The `data-hub-process` CLI lets you run instrument-specific parsing and processing locally, without S3 or API access. This is useful for debugging processors against real files.

```sh
uv run data-hub-process <command> <file>
```

Available commands:

| Command | Description |
| --- | --- |
| `gel-doc` | Process an Azure 600 Gel Doc TIFF (contrast-enhanced PNG + metadata) |
| `qpcr` | Parse dye channels from an Azure Cielo qPCR Cq Values CSV |
| `spectramax` | Parse metadata and raw well data from a SpectraMax `.xls` export |
| `tapestation` | Extract the tape type from a TapeStation CSV filename |

Example:

```sh
uv run data-hub-process gel-doc path/to/image.tif --output-dir out/
uv run data-hub-process spectramax path/to/plate.xls
```

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

- `click` — CLI framework
- `pandas` — data manipulation
- `matplotlib` — plotting
- `scikit-image` — image processing
- `tifffile` — TIFF file reading
- `pydantic` — data validation
- `requests` — HTTP client for the Data Hub API
- `aws-lambda-typing` — type stubs for Lambda events/context
- `data-hub-shared` — shared utilities (S3, Slack, enums)
