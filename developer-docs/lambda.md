# Lambda

The Data Hub Lambda function preprocesses raw instrument data uploaded to S3 and builds run-archive zips on demand for the web app's "Download all" actions. It can be triggered automatically by S3 events or manually via Function URL invocations from the web app. It runs an instrument-specific preprocessing pipeline (or the archive builder) and reports results back through the API.

## How it works

The Lambda has three invocation paths:

### S3 trigger (automatic)

1. An S3 `PutObject` event triggers the Lambda function.
2. The handler parses the S3 key to extract the instrument ID, run ID, and filename. The expected key layout is `{instrument_id}/{run_id}/{filename}`.
3. It dispatches to the appropriate instrument processor based on the instrument ID.
4. The processor downloads the raw file from S3, preprocesses it (e.g., extracting metadata), and creates/updates the run and files via the Data Hub API.

Slack notifications are sent by the **web app**, not the Lambda — see [Slack notifications](#slack-notifications) below.

### Function URL (manual reprocessing)

When a file fails processing (or needs to be re-run), users can trigger reprocessing from the run detail page in the web app. This invokes the Lambda's Function URL instead of going through S3:

1. The user clicks **Reprocess** on a failed or completed file in the web dashboard.
2. The web app's `POST /api/v1/files/:fileId/reprocess` endpoint transitions the file to `processing` status, clears any previous error, and sends a POST request to the Lambda Function URL.
3. The Function URL is configured with `AuthType: AWS_IAM`, so the web app SigV4-signs the request using credentials it gets via Vercel OIDC federation (the `WebAppS3Role` IAM role, which has `lambda:InvokeFunctionUrl` on this function's ARN). The body is a JSON payload containing a synthetic S3 event.
4. The Lambda handler detects the Function URL invocation (via `requestContext` in the event) and parses the S3 event from the request body. Inbound auth is enforced by AWS itself in front of the function — the handler never sees an unauthenticated request.
5. From here, processing follows the same dispatch logic as the S3 trigger path (steps 2–4 above).

### Function URL (archive build)

The web app's `GET /api/v1/instruments/:instrumentId/runs/:runId/download-archive` route delegates zip building to the Lambda so download bytes never traverse Vercel. This shares the Function URL with manual reprocessing and is distinguished by a `type: "build_archive"` field in the request body:

1. The web app POSTs `{ type: "build_archive", instrument_id, run_id, destination_bucket, destination_key, files: [{ key, name, source_bucket }, ...], job_id? }` to the Function URL using the same SigV4-signed flow as reprocessing. Each file carries its own `source_bucket` so a single archive can zip files that live in the raw bucket *and* the processed bucket (the common case for instruments that produce processed artifacts — SpectraMax CSVs, Hina JPGs, Azure 600 PNGs). For backward compat with pre-migration callers, a top-level `source_bucket` is still accepted as a fallback for files that omit the per-entry field.
2. The handler dispatches on the `type` discriminator and calls `archive_builder.build_run_archive`. Two security checks fire on every payload: (a) every input `key` must live under `{instrument_id}/{run_id}/` so a misconfigured caller can't exfiltrate cross-run/cross-tenant data, and (b) every `source_bucket` must be on the Lambda's allow-list — `AWS_S3_RAW_DATA_BUCKET` and `AWS_S3_PROCESSED_DATA_BUCKET` — so the builder can't be redirected at an arbitrary bucket the Lambda role might happen to have GetObject on.
3. The builder streams each S3 object through `zipfile.ZipFile` into an `_MultipartUploadStream` that buffers writes into ~16 MB parts and flushes each via `UploadPart`. Memory stays bounded regardless of total archive size, so a 200+ GB run zips inside the Lambda's standard memory budget. Entries are written `ZIP_STORED` (no compression — instrument output rarely compresses) with `force_zip64=True` (so individual entries ≥ 4 GB don't blow up the writer).
4. On success, the Lambda returns `{ archive_bucket, archive_key, size_bytes }`. If `job_id` was supplied, it also PATCHes `/api/v1/archive-jobs/:job_id` with the same fields and `status: "ready"`; on failure it PATCHes `status: "failed"` with `error_message`. The PATCH callback authenticates with `Authorization: Bearer <DATA_HUB_API_KEY>` — the same PAT the Lambda uses for every other Lambda → API call. The PATCH primarily serves to record terminal state for diagnostics and to surface `failed` quickly — the UI's polling target is the `/download-archive` route itself (whose first action is an S3 HEAD against the canonical archive key), so a finished build is downloadable the moment the multipart upload completes regardless of whether this PATCH lands.

See [Run archives](run-archives.md) for the full flow, S3 bucket layout, cache semantics, and operator runbook.

## Supported instruments

| Instrument | Module | Instrument ID |
| --- | --- | --- |
| Agilent 4150 TapeStation | `agilent_4150_tapestation` | `agilent-4150-tapestation` |
| Akta FPLC | `akta_fplc` | `akta-fplc` |
| Azure 600 Gel Doc | `azure_600_gel_doc` | `azure-600-gel-doc` |
| Azure Cielo qPCR | `azure_cielo_qpcr` | `azure-cielo-qpcr` |
| Epson V700 Scanner | `epson_v700_scanner` | `epson-v700-scanner` |
| Hina Microscope | `hina_microscope` | `hina-microscope` |
| InstantRaman | _(no Lambda processor)_ | `instant-raman` |
| SpectraMax iD3 Plate Reader | `spectramax_plate_reader` | `spectramax-id3-plate-reader` |
| SpectraMax iD5 Plate Reader | `spectramax_plate_reader` | `spectramax-id5-plate-reader` |

Each processor module exposes a `process_file()` function that accepts the run ID and filename (and instrument ID for SpectraMax readers) and reports progress back through the Data Hub API.

## Slack notifications

Slack channel notifications are sent by the **web app** (`web/lib/slack.ts`), not the Lambda. When the Lambda's `process_file` calls `POST /api/v1/instruments/:instrumentId/runs` to register a newly-detected run, that endpoint posts a single message per run to the incoming webhook URL configured in Settings > Notifications > Slack channel (workspace admins only). Subsequent files for the same run do not re-notify because the upsert is idempotent on `(instrument_id, run_id)`. File-level failures remain visible in the web app via the file row's `status='failed'` and `error_message` fields.

## Adding a new instrument

1. **Register the instrument.** Add a new member to the `Instrument` enum in `packages/shared/src/data_hub_shared/enums.py` and a corresponding entry in the `INSTRUMENT_ID_TO_NAME_MAP` in `packages/shared/src/data_hub_shared/constants.py`.

2. **Create a processor module.** Add a new module under `lambda/src/data_hub_lambda/` (e.g., `new_instrument.py`). It must expose:

   ```python
   def process_file(run_id: str, filename: str) -> None:
       """Process a file, reporting progress via the Data Hub API."""
       ...
   ```

3. **Register the dispatch.** Add an `elif` branch in the `lambda_handler` function in `lambda/src/data_hub_lambda/handler.py` that maps the new instrument ID to your `process_file` function.

4. **Add tests.** Add unit tests in `lambda/tests/` for the new processor.

5. **Configure the S3 trigger and deploy.** See [Deploying AWS infrastructure → Adding a Lambda processor for a new instrument](https://datahub.arcadiascience.com/docs/deploying-aws-infrastructure#adding-a-lambda-processor-for-a-new-instrument) for the `infra/template.yaml` trigger entry and the deploy steps.

## Local processing CLI

The `data-hub-process` CLI lets you exercise instrument-specific parsing and processing locally. Most subcommands run a single processor in isolation against a file on disk and print the result; the `handler` subcommand drives `lambda_handler` end-to-end against a local S3 mirror and the dev API.

```sh
uv run data-hub-process <command> [args]
```

Available commands:

| Command | Description |
| --- | --- |
| `epson-scanner` | Process an Epson V700 Scanner TIFF (resized JPEG preview + metadata) |
| `gel-doc` | Process an Azure 600 Gel Doc TIFF (contrast-enhanced PNG + metadata) |
| `hina` | Convert a Hina microscope ND2 file to a JPG overlay + metadata |
| `qpcr` | Parse dye channels from an Azure Cielo qPCR Cq Values CSV |
| `spectramax` | Parse metadata and raw well data from a SpectraMax `.xls` export |
| `tapestation` | Extract the tape type from a TapeStation CSV filename |
| `handler` | Stage a file into a local S3 mirror and invoke `lambda_handler` against the local dev API. See [Testing the Lambda end-to-end](local-development.md#testing-the-lambda-end-to-end) for the workflow. |

The first six subcommands need no S3 or API access — they call into the same parsing/processing utilities the lambda uses, but stop short of the network. `handler` is different: it expects a running dev API and a `LOCAL_S3_MIRROR` directory, and uses the same dispatch path production uses.

Examples:

```sh
uv run data-hub-process gel-doc path/to/image.tif --output-dir out/
uv run data-hub-process spectramax path/to/plate.xls
uv run data-hub-process handler azure-cielo-qpcr Experiment_20260101 cq.csv --source ~/Downloads/cq.csv
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
- `arcadia-microscopy-tools` — ND2 reading, channel handling, and multi-channel compositing for the Hina microscope
- `pydantic` — data validation
- `requests` — HTTP client for the Data Hub API
- `aws-lambda-typing` — type stubs for Lambda events/context
- `data-hub-shared` — shared utilities (S3, enums)
