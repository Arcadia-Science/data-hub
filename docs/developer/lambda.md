# Lambda

The Data Hub Lambda function preprocesses raw instrument data uploaded to S3 and builds run-archive zips on demand for the web app's "Download all" actions. It can be triggered automatically by S3 events or manually via Function URL invocations from the web app. It runs an instrument-specific preprocessing pipeline (or the archive builder) and reports results back through the API.

## How it works

The Lambda has three invocation paths:

### S3 trigger (automatic)

1. An S3 `ObjectCreated:*` event on the raw bucket triggers the Lambda (catch-all; no per-instrument prefix/suffix filters).
2. The handler parses the S3 key to extract the instrument ID, run ID, and filename. The expected key layout is `{instrument_id}/{run_id}/{filename}`.
3. For S3-triggered events, a cheap union of processor filename gates runs first. Non-matching files no-op without an API call.
4. The handler fetches the instrument via `GET /instruments/:id` and looks up a processor by `instrument_type` in `data_hub_lambda.processors`. Unmapped types (including `generic`) and per-type gate failures no-op.
5. The processor opens the raw file with `local_raw_file` in `raw_access.py`, then creates or updates the run and files via the Data Hub API using the event's `instrument_id`. `ObjectCreated:CompleteMultipartUpload` is included in the `ObjectCreated:*` trigger, so a multipart upload starts processing the same way a single PUT does.
   - The helper takes the bucket and key separately, so a `#` or `?` in a filename stays part of the key. AKTA and TapeStation never read the file, so they do not call it.
   - By default the helper downloads the raw file. A download has to fit on the function's disk with `OUTPUT_HEADROOM_BYTES` (512 MiB) to spare, which leaves room for what the processor writes next to it. A processor that reads the file in pieces passes `streams=True`. For those processors, files of `MOUNT_READ_MIN_BYTES` (1 GiB) or more, and files that will not fit on the disk, are read from the raw-bucket mount when `RAW_DATA_MOUNT_PATH` is set (`/mnt/raw` in AWS).
   - The helper waits up to `MOUNT_WAIT_TIMEOUT_S` for the mounted file to show the size S3 reports, because the mount can lag the upload that started the function. If the file does not appear and it fits on disk, the helper downloads it. S3 Files never imports a key with an empty, `.`, or `..` path part, a null byte, or a part longer than 255 bytes, so the helper does not wait for those keys.
   - If the file fits neither place, the file is marked failed and the raw object stays in S3. The helper deletes only a file it downloaded.
   - The wait compares sizes only. The S3 Files docs do not say whether a mounted file's modification time follows the object's `LastModified`, so an object overwritten with one of the same size can be read in its old version until the mount catches up.
   - Before waiting on the mount and before downloading, the helper stops if less than `DEADLINE_MARGIN_MS` of the invocation remains. Long steps inside a processor need their own `check_deadline` calls.

Slack notifications are sent by the **web app**, not the Lambda — see [Slack notifications](#slack-notifications) below.

### Function URL (manual reprocessing)

When a raw file fails processing (or needs to be re-run), users can trigger reprocessing from the run detail page in the web app. Processed artifacts (preview CSVs, posters, MP4s) are not eligible — they often share extensions with the watcher's raw patterns, and Lambda only ingests the original instrument files. This invokes the Lambda's Function URL instead of going through S3:

1. The user clicks **Reprocess** on an uploaded, failed, completed, or stalled raw file in the web dashboard, selects several files and clicks **Reprocess**, or clicks **Reprocess** on one or more runs (which queues every eligible raw file). The REST routes and the MCP tools `reprocess_file` and `reprocess_run` take the same path.
2. The web app checks each file, then moves every eligible file to `queued` status with one UPDATE. The UPDATE sets `queued_at` and clears the previous error, `processed_at`, and `processing_started_at`. A file that is already `queued` is rejected with a 409.
3. The web app then runs the dispatcher, which moves queued files to `processing` while fewer than the processing limit are in flight. See [The reprocess queue](#the-reprocess-queue).
4. For each file the dispatcher started, the web app sends a POST request to the Lambda Function URL. This happens in `after()`, once the HTTP response has been sent. See [When the invocation fails](#when-the-invocation-fails) for what the web app does with the response.
5. The Function URL is configured with `AuthType: AWS_IAM`, so the web app SigV4-signs the request using credentials it gets via Vercel OIDC federation (the `WebAppS3Role` IAM role, which has `lambda:InvokeFunctionUrl` on this function's ARN). The body is a JSON payload containing a synthetic S3 event.
6. The Lambda handler detects the Function URL invocation (via `requestContext` in the event) and parses the S3 event from the request body. Inbound auth is enforced by AWS itself in front of the function — the handler never sees an unauthenticated request.
7. From here, processing follows the same type-based dispatch as the S3 trigger path, except the cheap **union gate is skipped** so the handler always reaches the instrument lookup.
8. If the matched processor's own filename gate rejects the file, the handler PATCHes it to `failed` with `The {instrument_type} processor does not handle '{filename}'` instead of returning quietly. The web app moved the row to `processing` before invoking, and processors return without touching the row when the name isn't theirs — so a silent no-op would strand it there forever. The same recovery covers a missing instrument and an unmapped `instrument_type`.
9. When the Lambda PATCHes the file to `completed` or `failed`, the web app starts the next queued file.

#### The reprocess queue

Starting every file of a large run at once is what the queue prevents. Each Lambda copy calls the web app several times in its first seconds. With dozens of copies running together, those calls scaled the web app out, each instance opened its own database connections, and Postgres ran out of connections (error `53300`), which also failed unrelated requests.

The queue lives in the database. The `queued` value of `file_status` and the nullable `files.queued_at` column hold it. `dispatchQueuedFiles()` in `web/lib/api/file-reprocessing.ts` starts files from it:

- It first runs one indexed read that asks whether any queued file can start. Files that are deleted, files in a deleted run, and files with no S3 location do not count, so a queue that holds only those opens no transaction.
- It opens one transaction, sets `lock_timeout` to 5 seconds, and takes `pg_advisory_xact_lock`. The lock waits for the dispatcher that holds it. The holder keeps it for a few short queries, so the wait is short. After the holder commits, each waiter counts the files in flight again before it starts any file. That is why a burst of requests starts exactly the limit and never more. If the wait passes 5 seconds, the dispatcher logs a warning and returns without starting anything. The files stay queued, and the cron starts them.
- It counts raw, non-deleted files in flight, which are `processing` files inside the stall window (see `inFlightProcessingSql` in `web/lib/runs/stalled-processing.sql.ts`). The room is the limit minus that count. A stalled file does not count, because its processor is gone.
- It starts the oldest queued files first, ordered by `queued_at` and then file ID, up to the room. It skips the files that cannot start, which stay `queued`, so restoring a run puts its files back in line.
- It sets each started file to `processing`, sets `processing_started_at`, and clears `queued_at`. After the commit it invokes the Lambda for each started file in `after()`. The Function URL is BUFFERED, so a request stays open until processing finishes. That is why the invocation cannot run inside the request that queued the file.
- It does nothing when `LAMBDA_FUNCTION_URL` or the invoke credentials are missing. Files marked `processing` with no invocation would only sit in `processing` until they stall.

Four things run the dispatcher:

- Every reprocess request, right after it queues files.
- Every `completed` or `failed` PATCH to `PATCH /api/v1/files/:fileId`, in `after()`. This is what keeps the queue moving. A repeat of a final status runs it again, which does no harm.
- An invocation that ended without a result, after it marks its file `failed` (see below).
- The `/api/cron/reprocess-queue` cron, every minute (`web/vercel.json`, authenticated with `CRON_SECRET`). It starts files that the other triggers miss: a file that stalled, a dispatch that gave up waiting for the lock, a dispatch that failed, and a file that went back to the queue after a 429. Which deployments run it depends on Vercel's schedule settings; see [CI and deployment](ci-and-deployment.md#web-application-vercel).

The limit is 10 raw files unless `PROCESSING_CONCURRENCY_LIMIT` sets another number (see [Getting started](getting-started.md#web-application)). Raw files that S3 events start count toward the limit, but they start directly and never wait in the queue. Archive builds do not count.

A queued file can still be PATCHed to `processing`, which is what the Lambda does when an S3 re-upload of that file starts it. The PATCH clears `queued_at`. Older watchers never see `queued`: they read a file's status only after marking it uploaded or cancelling an upload, and a queued file can do neither.

#### When the invocation fails

The dispatcher sets a file to `processing` before it invokes the Lambda, and the Lambda reports its own result with a PATCH. The web app also reads the HTTP response of the invocation, in `invokeLambdaForFile` in `web/lib/api/file-reprocessing.ts`. Because the Function URL is BUFFERED, a response means the invocation has ended. What the web app does depends on the outcome:

| Outcome | What happens to the file |
| --- | --- |
| A non-2xx response other than 429 | The file becomes `failed` with `Processing ended without a result: the Lambda returned HTTP {status}. Reprocess the file to try again.` Then the dispatcher runs, so the next queued file takes the slot. |
| Signing the request fails, or the connection fails before the request is sent (for example `ECONNREFUSED` or `ENOTFOUND`) | The file becomes `failed` with `Processing could not start: Data Hub could not send the request to the Lambda. Reprocess the file to try again.` Then the dispatcher runs. |
| HTTP 429, which means the Lambda was throttled | The file goes back to `queued` in its old place in line. The dispatcher does not run, because the Lambda has no room. The cron tries again. |
| An abort, a timeout, or a reset after the request was sent | Nothing changes. The Lambda may still be running and will report its own result. |

The update that fails or requeues the file matches `status = 'processing'` and the exact `processing_started_at` that the dispatch wrote. If the Lambda already PATCHed the file, or a newer start replaced this one, nothing matches and the file is left alone.

The `after()` callback runs only as long as the route's `maxDuration` allows, and `/mcp/v1` sets 60 seconds. A Lambda that runs longer than the route allows ends the callback before it answers. Nothing then reads the response, so a failure after that point is never seen by the web app. That file stays `processing` until it stalls (20 minutes), and the cron fills its slot after that.

If the Lambda answers an error for every file, for example during an outage, each failure frees a slot that the next queued file takes, so the whole queue fails in turn. Each file keeps a message that says why, and **Reprocess** puts it back in the queue.

#### Errors and retries on API calls

The Lambda reports to the web app through `DataHubClient` in `lambda/src/data_hub_lambda/api_client.py`.

- When an API error has no message, the error text names the status: `Data Hub API returned HTTP 500 with no error message`. Next.js answers a thrown route handler with an empty 500, and the processors store the error text on the file, so a blank message showed as a blank error.
- Every call except `get_instrument` retries on a connection error, a timeout, or a 5xx (`_request_with_retry`). That covers `get_run`, `ensure_run`, `create_file`, `update_run`, `update_archive_job`, and every `update_file`, including one that sets `completed` or `failed`. A call makes four attempts at most. A 4xx is raised at once.
- The waits before the retries are 1, 2, and 4 seconds. Each wait gets a random extra of up to 50% of itself (`_jittered`), so Lambdas that hit the same outage do not all retry at the same moment. The tests patch `_jittered` to keep the waits fixed.
- A retry only starts when the invocation has enough time left. `deadline.seconds_until_time_limit()` gives the seconds before the Lambda runtime kills the invocation, from the same context reading that `handler.py` records with `record_invocation_deadline`. When that is less than the next wait plus one read timeout (30 seconds) plus a 5 second margin, the client raises the last error instead of retrying. The CLI and the tests set no deadline, so they keep the full schedule. The check uses the runtime limit and not the earlier `check_deadline` cutoff, because that cutoff leaves 60 seconds to write a failure, and the retries of that write need those seconds.
- A repeat of a final status is safe because `PATCH /api/v1/files/:fileId` accepts `completed` after `completed` and `failed` after `failed`. The repeat keeps the first `processed_at`. If the first attempt reached the server and only the response was lost, the retry succeeds instead of failing a write that landed.
- `get_instrument` keeps its own shorter retry and a short-lived cache.

### Function URL (archive build)

The web app's `GET /api/v1/instruments/:instrumentId/runs/:runId/download-archive` route delegates zip building to the Lambda so download bytes never traverse Vercel. This shares the Function URL with manual reprocessing and is distinguished by a `type: "build_archive"` field in the request body:

1. The web app POSTs `{ type: "build_archive", instrument_id, run_id, destination_bucket, destination_key, files: [{ key, name, source_bucket }, ...], job_id? }` to the Function URL using the same SigV4-signed flow as reprocessing. Each file carries its own `source_bucket` so a single archive can zip files that live in the raw bucket *and* the processed bucket (the common case for instruments that produce processed artifacts — SpectraMax CSVs, Hina JPGs, Azure 600 PNGs). For backward compat with pre-migration callers, a top-level `source_bucket` is still accepted as a fallback for files that omit the per-entry field.
2. The handler dispatches on the `type` discriminator and calls `archive_builder.build_run_archive`. Two security checks fire on every payload: (a) every input `key` must live under `{instrument_id}/{run_id}/` so a misconfigured caller can't exfiltrate cross-run/cross-tenant data, and (b) every `source_bucket` must be on the Lambda's allow-list — `AWS_S3_RAW_DATA_BUCKET` and `AWS_S3_PROCESSED_DATA_BUCKET` — so the builder can't be redirected at an arbitrary bucket the Lambda role might happen to have GetObject on.
3. The builder streams each S3 object through `zipfile.ZipFile` into an `_MultipartUploadStream` that buffers writes into ~16 MB parts and flushes each via `UploadPart`. Memory stays bounded regardless of total archive size, so a 200+ GB run zips inside the Lambda's standard memory budget. Entries are written `ZIP_STORED` (no compression — instrument output rarely compresses) with `force_zip64=True` (so individual entries ≥ 4 GB don't blow up the writer).
4. On success, the Lambda returns `{ archive_bucket, archive_key, size_bytes }`. If `job_id` was supplied, it also PATCHes `/api/v1/archive-jobs/:job_id` with the same fields and `status: "ready"`; on failure it PATCHes `status: "failed"` with `error_message`. The PATCH callback authenticates with `Authorization: Bearer <DATA_HUB_API_KEY>` — the same PAT the Lambda uses for every other Lambda → API call. The PATCH primarily serves to record terminal state for diagnostics and to surface `failed` quickly — the UI's polling target is the `/download-archive` route itself (whose first action is an S3 HEAD against the canonical archive key), so a finished build is downloadable the moment the multipart upload completes regardless of whether this PATCH lands.

See [Run archives](run-archives.md) for the full flow, S3 bucket layout, cache semantics, and operator runbook.

## Supported instrument types

Dispatch is by `instrument_type` (Postgres/TS enum), not instrument ID. The registry lives in `lambda/src/data_hub_lambda/processors.py`; the web reprocess gate mirrors the same keys in `web/lib/instruments/processable-types.ts`.

| `instrument_type` | Module | Filename gate |
| --- | --- | --- |
| `tape_station` | `agilent_4150_tapestation` | `.pdf` |
| `fplc` | `akta_fplc` | `.pdf` |
| `gel_doc` | `azure_600_gel_doc` | `.tif` / `.tiff` |
| `qpcr` | `azure_cielo_qpcr` | `.csv` / `.pdf` / `.aze` |
| `epson_v700_scanner` | `epson_v700_scanner` | `.tif` / `.tiff` |
| `hina_microscope` | `hina_microscope` | `.nd2` |
| `plate_reader` | `spectramax_plate_reader` | `.xls` |
| `dishcam` | `dishcam` | `.tif` / `.tiff` / `run.json` (also `run~<hash>.json`) |
| `aunty` | `unchained_labs_aunty` | `.xlsx` |
| `generic`, `instant_raman` | — | — |

**One type = one vendor's output format.** Names like `qpcr` and `fplc` sound generic, but the parsers behind them are vendor-specific (Azure Cielo, ÄKTA, …). Adding a second vendor under an existing type requires splitting the type, not reusing it.

Seeded `jolene-fplc` stays `generic` until an operator confirms its PDFs match the ÄKTA processor and edits the type to `fplc`. Typing an unknown FPLC as `fplc` would feed non-ÄKTA files into that parser.

Each processor module exposes `process_file(instrument_id, run_id, filename)` and reports progress through the Data Hub API.

DishCam reads the run's file list (`GET /instruments/:id/runs/:runId`, which needs `runs:read` on the Lambda token) and pairs each TIFF with the sidecar from the same folder. A run can hold several captures that reuse `run.json`. The later copy is stored as `run~<8 hex>.json`, where the hex is a hash of the folder. A folder with no sidecar of its own uses the plain `run.json`, which is what older watchers stored for every capture. The parsed sidecar is written onto that TIFF's file record, with a `sidecar` key naming the file it came from. Run-level metadata is written only from the plain `run.json`, so a later capture does not replace it.

A folder's own sidecar can be reported after its stacks, so a stack may first be encoded with the plain `run.json`. When that folder's sidecar reaches S3, its event re-encodes every completed stack in the folder whose `sidecar` key names a different file. A stack with no `sidecar` key counts as encoded from `run.json`, which is what the Lambda used before the key existed. That event skips a stack that is still encoding, so an encode that used another folder's sidecar reloads the file list when it finishes and re-encodes if the folder's own sidecar has arrived.

DishCam decodes one TIFF page at a time and pipes it to ffmpeg through the shared encoder in `data_hub_lambda/video.py`, so it passes `streams=True` and reads large stacks from the raw-bucket mount. Before each frame it checks the time left in the invocation. When time is short, the encode stops between frames and the stack is marked failed with a message that says how far it got, such as "12 of 400 frames done".

Hina Microscope also passes `streams=True`. It reads an ND2 one frame at a time, max-projects Z, and keeps the first position, all in the file's own pixel type. The JPG is the first time point. A file with more than one time point (`sizes["T"] > 1`) is read again, one time point at a time, and each rendered frame is piped to the same encoder as DishCam to make `{stem}.mp4`. Every frame uses the contrast range of the first, and the frame rate comes from the time loop's measured `periodDiff.avg`, floored at 10 fps. A time point with no frames, as in a capture stopped early, is skipped. The JPG is uploaded before the encode starts, so a failed or timed-out encode marks the file failed and leaves the JPG. Before reading any frames, it checks that the full-size planes fit. Reading holds the running projection and one decoded frame, so twice the planes' size has to stay within `MAX_PREVIEW_BYTES`. For 16-bit pixels, that only fails an image around 32,000 pixels per side with one channel, 19,000 with three, and 16,000 with four. The file is marked failed with a message that the raw file can still be downloaded.

Rendering needs much more memory than reading, because the contrast stretch and the color overlay work in 64-bit numbers. An image whose estimated render size (`preview_bytes`) is over `MAX_PREVIEW_BYTES` is shrunk before rendering. `preview_shrink_factor` picks the smallest whole number that makes the render fit, and each plane becomes the average of that many pixels per side, in the plane's own pixel type. The full-size planes are freed as they are replaced. An image that already fits is not shrunk, so its preview does not change. The run metadata still records the real image size, and the preview JPG is smaller than the image.

The Lambda scope preset is `instruments:read`, `runs:read`, `runs:create`, `runs:update`, `files:create`, `files:update`, and `archive-jobs:write`. `runs:read` is what lets DishCam load the file list. Mint a new token from the preset and update `DATA_HUB_API_KEY` before deploying a Lambda that calls `get_run`; the previous token returns 403. Confirm another instrument still processes, then revoke the old token. Every processor shares this token.

The `qpcr` processor also reads the Azure Cielo's native `.AZE` project files (`azure_cielo_qpcr/aze.py`, reverse-engineered — no vendor spec exists). An `.AZE` is a sequence of big-endian u32 length-prefixed segments: metadata JSON, plate-layout JSON, analysis settings, and a data segment whose pretty-printed JSON carries the melt curves as flat well-major `MeltCurveChannelN` arrays over a shared centidegree `MeltCurveTemper` axis. A run with melt data produces `{run_id}_aze_melting_curve_derivatives.csv`, `{run_id}_aze_melting_curve_plate.json`, and a `{run_id}_aze_experiment.json` sidecar with instrument metadata (device id, software versions, run times); setup-only projects complete with no artifacts. The CSV export path is untouched when both exist. One caveat: `.AZE` melt arrays are raw fluorescence, while the vendor's `_MeltingCurve.csv` export may be baseline-processed — derivative peak positions (Tm) agree, absolute values can differ.

## Slack notifications

Slack channel notifications are sent by the **web app** (`web/lib/slack.ts`), not the Lambda. When the Lambda's `process_file` calls `POST /api/v1/instruments/:instrumentId/runs` to register a newly-detected run, that endpoint posts a single message per run to the incoming webhook URL configured in Settings > Integrations (workspace admins only). Subsequent files for the same run do not re-notify because the upsert is idempotent on `(instrument_id, run_id)`. File-level failures remain visible in the web app via the file row's `status='failed'` and `error_message` fields.

## Adding a new instrument / processor

1. **Add or reuse an `instrument_type`.** If this is a new vendor format, extend `instrumentTypeEnum` in `web/lib/db/schema.ts` and generate an `ALTER TYPE ... ADD VALUE` migration. Create the instrument row in the web app with that type (or edit an existing row). The shared `Instrument` enum in `packages/shared` is optional — only needed for watcher/CLI display naming, not for Lambda dispatch.

2. **Create a processor module** under `lambda/src/data_hub_lambda/` that exposes:

   ```python
   def process_file(instrument_id: str, run_id: str, filename: str) -> None:
       """Process a file, reporting progress via the Data Hub API."""
       ...
   ```

3. **Register it** in `lambda/src/data_hub_lambda/processors.py` (type → `process_file` + `matches_filename`) and add the same type string to `PROCESSABLE_INSTRUMENT_TYPES` in `web/lib/instruments/processable-types.ts`.

4. **Add tests** for the processor and for the new registry gate.

5. **Deploy the Lambda image.** The raw bucket already notifies on all `ObjectCreated:*` events — no new S3 trigger entry is required.

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
| `hina` | Convert a Hina microscope ND2 file to a JPG overlay + metadata, and a timelapse to an MP4 as well |
| `qpcr` | Parse dye channels from an Azure Cielo qPCR Cq Values CSV |
| `spectramax` | Parse metadata and raw well data from a SpectraMax `.xls` export |
| `tapestation` | Extract the tape type from a TapeStation CSV filename |
| `dishcam` | Convert a DishCam TIFF stack plus the `run.json` from the same folder into an MP4 preview and JPEG poster |
| `synthetic-tiff` | Write an uncompressed RGB TIFF stack of 12 MP frames, at least `--size-gib` or `--size-bytes` large, for timing a large DishCam encode. The writer lives in the `data_hub_lambda_devtools` package, which the Lambda never imports. |
| `aunty` | Parse an Unchained Labs Aunty `.xlsx` export into a curves CSV and plate JSON |
| `handler` | Stage a file into a local S3 mirror and invoke `lambda_handler` against the local dev API. See [Testing the Lambda end-to-end](local-development.md#testing-the-lambda-end-to-end) for the workflow. |

The instrument-specific subcommands need no S3 or API access — they call into the same parsing/processing utilities the lambda uses, but stop short of the network. `handler` is different: it expects a running dev API and a `LOCAL_S3_MIRROR` directory, and uses the same dispatch path production uses.

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

1. **ffmpeg stage**: Copies a static linux/amd64 `ffmpeg` (libx264) from the version-tagged `mwader/static-ffmpeg` image.
2. **Builder stage**: Uses `uv` to export and install third-party dependencies into the Lambda task root.
3. **Final stage**: Copies ffmpeg, the installed dependencies, and the `data_hub_shared` and `data_hub_lambda` source packages.

The entry point is `data_hub_lambda.handler.lambda_handler`.

## Dependencies

The Lambda function depends on a scientific Python stack:

- `click` — CLI framework
- `pandas` — data manipulation
- `matplotlib` — plotting
- `scikit-image` — image processing
- `tifffile` — TIFF file reading
- `openpyxl` — Excel reading for Unchained Labs Aunty `.xlsx` exports
- `ffmpeg` — static linux/amd64 binary from `mwader/static-ffmpeg` for the DishCam and Hina timelapse H.264 encodes
- `arcadia-microscopy-tools` — ND2 reading, channel handling, and multi-channel compositing for the Hina microscope
- `pydantic` — data validation
- `requests` — HTTP client for the Data Hub API
- `aws-lambda-typing` — type stubs for Lambda events/context
- `data-hub-shared` — shared utilities (S3, enums)
