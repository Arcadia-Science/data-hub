# Run archives

The "Download all" actions on the run detail page and the runs table deliver every active file in a run as a single zip. Rather than streaming the zip through the Vercel function (which previously drove ~100 GB/day of [Fast Origin Transfer](https://vercel.com/docs/manage-cdn-usage#fast-origin-transfer)), the web app delegates building to the Lambda and serves the result via a presigned S3 URL — bytes never traverse Vercel.

Each archive can mix files from the raw bucket and the processed bucket in a single zip. This matters for instruments that produce processed artifacts via Lambda preprocessing (SpectraMax raw `.xls` → processed CSV; Hina `.nd2` → processed JPG; Azure 600 Gel Doc `.tif` → processed PNG): the run's file rows reference both buckets, and "Download all" zips them together.

This page covers the end-to-end flow, the cache + dedup model, and the on-call runbook. For the Lambda invocation contract, see [Lambda → Function URL (archive build)](../reference/lambda.md#function-url-archive-build). For the HTTP endpoints, see [REST API → Archive jobs](https://arcadia-data-hub-docs.vercel.app/docs/api-reference#archive-jobs).

## Flow

```
Browser → /download-archive (web app)
                │
                │ HEAD s3://archives/runs/{instr}/{run}/{fp}.zip
                │   ├─ exists  → 302 presigned URL (cache hit, no Lambda)
                │   └─ missing → continue
                │
                ├─ Insert archive_jobs row (status=building) — partial unique index dedupes
                │ next/server `after()` POSTs Lambda; route returns 202 immediately
                │ Lambda PATCHes /api/v1/archive-jobs/:id with status=ready (or failed)
                │ UI re-issues /download-archive every few seconds; each poll re-runs the
                │ S3 HEAD short-circuit, so the cache hit is what unlocks the download
                │   ├─ HEAD hit → 200 { status: ready, download_url } → trigger download
                │   └─ HEAD miss → 202 { job_id, status: building } → keep polling
                └─ When ready, UI follows download_url to the presigned URL
```

Every cache miss goes async, regardless of archive size. The route does the cheap stuff inline — cache HEAD, dedup INSERT into `archive_jobs` — then schedules the Lambda Function URL POST via `next/server`'s `after()` and returns `202 { job_id }` to the client immediately. The `after()` callback awaits the Lambda's synchronous response so transport-level failures (Function URL unreachable, 5xx, misconfigured IAM) get logged and reflected back into the row as `status='failed'`. Builds shorter than `maxDuration` (300s, Vercel Pro's hard cap) land that callback cleanly; longer builds get the function killed before the callback finishes, and we rely on the Lambda's own PATCH-on-failure path plus the dialog's S3 HEAD polling to recover.

## S3 layout

Archives live in a separate bucket per environment, provisioned by [`infra/template.yaml`](../../infra/template.yaml):

- **Bucket:** `arcadia-data-hub-archives-{staging,production}`.
- **Public access:** fully blocked. Reads happen exclusively via short-lived presigned GET URLs; writes happen exclusively from the Lambda execution role.
- **Lifecycle:**
  - `Expiration: 7 days` — every archive object is garbage-collected after a week so storage cost is bounded by *recent download activity*, not total run history. Re-clicking "Download all" after expiry rebuilds.
  - `AbortIncompleteMultipartUpload: 1 day` — failed multipart uploads (e.g. Lambda timeout mid-build) don't accumulate as orphan parts.
- **Key shape:** `runs/{instrument_id}/{run_id}/{fingerprint}.zip`. The instrument and run IDs are kept in the path so a stray `aws s3 ls` is self-explanatory.

## Cache + dedup model

### Fingerprint = cache key

The fingerprint is a sorted SHA-256 of `(file_id, s3_key)` pairs:

```ts
// web/lib/api/archive-builder.ts
[...files].map((f) => `${f.id}:${f.s3Key}`).sort().join("|")
```

Properties this gives us:

- **Adding or removing a file** changes the fingerprint, so a stale archive can never be served — the next request will HEAD a different key and miss.
- **Reprocessing** that rewrites `files.s3_key` invalidates the archive.
- **Filtered downloads** (`?file_ids=1,2,3`) cache independently of the unfiltered archive because their input set differs.
- **No collision risk** in practice: SHA-256 of a sorted run manifest is far more than unique enough; an attacker would need preimage capability and write access to the source bucket to weaponize this.

### `archive_jobs` table dedups in-flight builds

Two simultaneous "Download all" clicks must not double-invoke the Lambda. The schema enforces this with a *partial* unique index:

```sql
-- web/drizzle/0016_add_archive_jobs.sql
CREATE UNIQUE INDEX archive_jobs_inflight_unique_idx
  ON archive_jobs (instrument_run_id, fingerprint)
  WHERE status IN ('pending', 'building');
```

The route `INSERT … ON CONFLICT DO NOTHING`s; on conflict it `SELECT`s the existing row and reuses it. The request that *won* the insert (or had to insert a fresh row because the prior job had already terminated) is the only one that calls the Lambda — losing requests skip the invocation entirely and return `202 { job_id }`, attaching their own polling (re-issues of `/download-archive`) to the existing build. This keeps Lambda spend and S3 part uploads from doubling on rapid concurrent clicks. Once the row transitions to `ready` or `failed`, the partial-index predicate stops applying and a future request can insert a new job.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `S3_ARCHIVES_BUCKET` | Vercel | Bucket the route HEADs and presigns from. Must match the SAM-provisioned bucket for the env. |
| `LAMBDA_FUNCTION_URL` | Vercel | Function URL of the Data Hub Lambda. Required — the route returns `503` if it's unset. |
| `AWS_ROLE_ARN` | Vercel | OIDC role the web app assumes to SigV4-sign Function URL invocations. Must be the `WebAppS3Role` ARN from the per-env stack (it carries the `lambda:InvokeFunctionUrl` policy on the Lambda's ARN). The same role also signs S3 presigns. |
| `AWS_S3_ARCHIVES_BUCKET` | Lambda | Set automatically by SAM via `!Ref ArchivesBucket`. The Lambda only writes to this bucket. |
| `DATA_HUB_API_URL` | Lambda | Base URL of the web API (including `/api/v1`). The `_post_archive_job_status` callback PATCHes `/archive-jobs/:id` against this. |
| `DATA_HUB_API_KEY` | Lambda | PAT used to authenticate every Lambda → API call, including the archive-job callback PATCH. |

## Runbook

### A job is stuck in `building`

```sql
SELECT id, instrument_run_id, fingerprint, status, created_at, completed_at, error_message
FROM archive_jobs
WHERE status = 'building' AND created_at < now() - interval '15 minutes';
```

Likely causes, in order of frequency:

1. **Lambda errored before the PATCH fired.** Check CloudWatch logs for `_handle_build_archive` failures around the job's `created_at`. Typical culprits: source object deleted between row insert and Lambda fetch (404 from `GetObject`), or a multipart upload that exceeded the function timeout.
2. **PATCH callback failed.** The Lambda logs `Failed to PATCH archive-job %s` if the web app rejected the update (auth issue, web app down, `DATA_HUB_API_URL` pointing at a deploy that doesn't have the `archive-jobs/[id]` route yet). The build itself may have succeeded — check the archives bucket for the expected key. **The UI tolerates this case:** the dialog re-issues `/download-archive` (which HEADs S3 first) on every poll rather than reading the row's `status`, so a finished build is downloaded the moment the multipart upload completes regardless of whether the row was ever flipped to `ready`. The stuck row only blocks future *new* builds for the same fingerprint until the 20-minute stale-row sweep kicks in. If you want to clean up immediately, `UPDATE archive_jobs SET status='ready', archive_bucket='…', archive_key='…' WHERE id = '…'` is the easiest manual path, or just `DELETE` it.
3. **Async path lost the `after()` callback.** Vercel `next/server` `after()` is best-effort; in rare cases (SIGTERM during scale-down) it can drop. The row will sit in `building` until a new download-archive request for the same fingerprint arrives — see "Self-healing" below.

#### Self-healing

The download-archive route runs `expireStaleArchiveJobs` on every request: any `pending`/`building` row older than `STUCK_BUILD_TIMEOUT_MS` (20 minutes) is flipped to `failed` with `error_message = "Build did not report completion within the expected window..."` before the dedup INSERT runs. So in practice a stuck row only blocks new builds for the first 20 minutes after the Lambda death, and the user's next click after that automatically rebuilds. To force this manually without waiting for traffic, just `UPDATE archive_jobs SET status='failed' WHERE id = '...'` or `DELETE` the row — both are safe. The partial unique index makes either path race-free.

### Downloads are returning 502

`Archive builder failed: …` 502s come from the route when `invokeBuildArchive` returned `{ ok: false }`. The most common shapes:

- `Failed to reach archive builder: fetch failed` — Function URL unreachable. Check `LAMBDA_FUNCTION_URL` is set and the Lambda function exists in the right region.
- `Archive builder returned 403` — SigV4 signature rejected. Most often means Vercel's assumed role (`AWS_ROLE_ARN`) doesn't carry `lambda:InvokeFunctionUrl` on the Lambda's ARN, or the Function URL was redeployed with `AuthType: NONE` (the policy condition only allows `AWS_IAM`). Confirm the `WebAppS3Role` policy in `infra/template.yaml` still includes `LambdaFunctionUrlInvoke`.
- `Archive builder returned 500` — Lambda hit an unhandled exception. Check CloudWatch; typical causes are missing IAM perms after a SAM redeploy that drifted, or a source object `KeyError` from a file row whose S3 key no longer exists.

### Downloads are returning 503

`Archive builder is not configured` means `LAMBDA_FUNCTION_URL`, `S3_ARCHIVES_BUCKET`, or AWS credentials (`AWS_ROLE_ARN` on Vercel, or static keys locally) are unset on the deploy. Set all three and redeploy.

### An archive looks stale (wrong files)

This shouldn't be possible by construction (fingerprint includes every file's `id` + `s3_key`), but to confirm:

1. Pull the current `files` rows for the run.
2. Compute the fingerprint locally with the same `id:s3_key` sort + SHA-256.
3. Compare to the cached object key in the archives bucket. If the fingerprints differ, the route would HEAD a different key and miss — the user is hitting a different archive than they think (likely a filtered "Download all" they triggered earlier).
4. If the fingerprints match and the archive contents are wrong, that's a real bug in the Lambda builder — capture the `archive_jobs` row and the source bucket listing and file an issue.

### "Why is `arcadia-data-hub-archives-prod` growing?"

It shouldn't, beyond a 7-day rolling window. If it is:

- Lifecycle didn't apply: `aws s3api get-bucket-lifecycle-configuration --bucket arcadia-data-hub-archives-production`. Reapply via SAM if missing.
- Orphaned multipart uploads: `aws s3api list-multipart-uploads --bucket arcadia-data-hub-archives-production`. The 1-day abort lifecycle should reap these; if not, abort manually.

## Why this design

Some choices that aren't obvious from reading the code:

- **No compression.** `ZIP_STORED` skips deflate. Microscope ND2s, gel TIFFs, and qPCR CSVs barely compress, and Lambda CPU spent on deflate is wall-clock the user is waiting through.
- **No on-disk staging.** A 300 GB Hina run wouldn't fit in Lambda's 10 GB `/tmp` and we don't want to special-case staging anyway. Streaming S3 → zip writer → S3 multipart keeps memory bounded and works for any size.
- **`force_zip64=True` everywhere.** A single 4+ GB entry would otherwise raise inside `ZipFile.open`. Cheaper to always emit ZIP64 headers than to gate on entry size.
- **Key-prefix validation in the Lambda.** Even though the web app generates the key list, the Lambda re-validates that every input lives under `{instrument_id}/{run_id}/`. A caller with `lambda:InvokeFunctionUrl` (e.g. via a compromised Vercel role) shouldn't be able to turn the builder into a generic S3-prefix exfiltration tool.
- **Fingerprint over a hash of file *content*.** Hashing content would mean Lambda has to read every byte before it knows the cache key — defeating the cache. Hashing `(id, s3_key)` is cheap and correct because reprocessing changes the key.
