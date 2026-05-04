import { getS3ArchivesBucket } from "@/lib/s3";
import crypto from "node:crypto";

// Threshold below which we await the Lambda response inside the request
// handler and 302 directly. Above this size, we skip the inline await and
// return a job ID up front so the UI can poll.
//
// The route's `maxDuration` is 300s (Vercel Pro's hard cap). The Lambda
// builder runs serially (one GetObject + one UploadPart at a time) and in
// practice sustains ~100–150 MB/s, so 25 GB lands inside the 5-minute
// budget with margin to spare. Anything larger goes straight to async so
// we never block on a request that can't finish.
const DEFAULT_SYNC_THRESHOLD_BYTES = 25 * 1024 * 1024 * 1024; // 25 GB

export function getSyncArchiveThresholdBytes(): number {
  const raw = process.env.SYNC_ARCHIVE_THRESHOLD_GB;
  if (!raw) return DEFAULT_SYNC_THRESHOLD_BYTES;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SYNC_THRESHOLD_BYTES;
  }
  return Math.floor(parsed * 1024 * 1024 * 1024);
}

// Inputs to `fingerprintFiles`. Only the fields that participate in the
// hash are accepted — adding extra fields here would suggest they affect
// cache identity when they don't.
export type ArchiveFileInput = {
  id: number;
  s3Key: string;
};

// Stable hash of the (file_id, s3_key) pairs that compose an archive. Adding
// or removing a file changes the fingerprint, so the route never serves a
// stale zip after a run's contents change. Sorting by id keeps the value
// stable regardless of database ordering.
//
// SHA-256 is overkill for what is effectively a cache key — but it's the
// project's house default, costs nothing at this input size, and avoids
// triggering "why is SHA-1 here" review noise. The full digest is kept (no
// truncation) so the value collides only on actual SHA-256 collisions.
export function fingerprintFiles(files: ArchiveFileInput[]): string {
  const canonical = [...files]
    .map((f) => `${f.id}:${f.s3Key}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

const ARCHIVE_KEY_PREFIX = "runs/";

export function getArchiveKey(
  instrumentId: string,
  runId: string,
  fingerprint: string
): string {
  // Keep the instrument and run id in the path so a stray `aws s3 ls` is
  // self-explanatory. The fingerprint disambiguates filtered ("?file_ids=")
  // archives from full-run archives.
  return `${ARCHIVE_KEY_PREFIX}${instrumentId}/${runId}/${fingerprint}.zip`;
}

// Inverse of `getArchiveKey`. Returns `null` if the key doesn't match the
// canonical layout (e.g. legacy / hand-edited rows). Used by the polling
// endpoint to derive a human-readable download filename without joining
// against `instrument_runs` on every poll.
export function parseArchiveKey(
  key: string
): { instrumentId: string; runId: string; fingerprint: string } | null {
  if (!key.startsWith(ARCHIVE_KEY_PREFIX)) return null;
  const parts = key.slice(ARCHIVE_KEY_PREFIX.length).split("/");
  if (parts.length !== 3) return null;
  const [instrumentId, runId, tail] = parts;
  if (!instrumentId || !runId || !tail.endsWith(".zip")) return null;
  const fingerprint = tail.slice(0, -".zip".length);
  if (!fingerprint) return null;
  return { instrumentId, runId, fingerprint };
}

// Derives the filename a browser should save the downloaded archive under.
// Centralised here so the sync (download-archive route) and async
// (archive-jobs poll) paths produce the same name, and the helper accepts a
// missing `runId` (e.g. malformed archive_key) by falling back to a generic
// "archive.zip".
export function getArchiveDownloadFilename(runId: string | null): string {
  return runId ? `${runId}.zip` : "archive.zip";
}

type LambdaConfig = { url: string; token: string };

// Cheap, side-effect-free check used by the route to short-circuit with a
// 503 *before* it inserts an `archive_jobs` row or fires `after()`. Checks
// every env var the build pipeline needs — the Lambda Function URL + token
// for the dispatch, and `S3_ARCHIVES_BUCKET` for the cache-hit HEAD and
// presign — so a misconfigured deploy fails uniformly with one clear
// error rather than half-failing inside `getS3ArchivesBucket`.
//
// The throwing `getLambdaConfig` / `getS3ArchivesBucket` helpers are still
// used downstream — this check is the entry-point gate.
export function isArchiveBuilderConfigured(): boolean {
  return Boolean(
    process.env.LAMBDA_FUNCTION_URL &&
    process.env.LAMBDA_INVOKE_TOKEN &&
    process.env.S3_ARCHIVES_BUCKET
  );
}

function getLambdaConfig(): LambdaConfig {
  const url = process.env.LAMBDA_FUNCTION_URL;
  const token = process.env.LAMBDA_INVOKE_TOKEN;
  if (!url || !token) {
    throw new Error(
      "LAMBDA_FUNCTION_URL and LAMBDA_INVOKE_TOKEN must be set to build archives"
    );
  }
  return { url, token };
}

export type InvokeBuildArchiveInput = {
  jobId?: string;
  instrumentId: string;
  runId: string;
  // Per-file source bucket so a single archive can mix files from the raw
  // bucket and the processed bucket (e.g. SpectraMax raw .xls + Lambda-
  // produced processed CSV). The Lambda allow-lists each bucket against its
  // own configured raw + processed env vars, so this is not a pivot point
  // for an invoke-token leak.
  files: { s3Key: string; filename: string; sourceBucket: string }[];
};

export type InvokeBuildArchiveResult =
  | {
      ok: true;
      archiveBucket: string;
      archiveKey: string;
      sizeBytes: number;
    }
  | { ok: false; status: number; message: string };

// Issues a synchronous archive-build request to the Lambda Function URL and
// awaits the result. Mirrors the patterns in `file-reprocessing.ts`. Throws
// if Lambda env vars are missing — the route is fully dependent on the
// builder, so a misconfigured deploy should fail loudly rather than silently
// degrade.
export async function invokeBuildArchive(
  input: InvokeBuildArchiveInput,
  fingerprint: string
): Promise<InvokeBuildArchiveResult> {
  const lambda = getLambdaConfig();

  const archiveBucket = getS3ArchivesBucket();
  const archiveKey = getArchiveKey(
    input.instrumentId,
    input.runId,
    fingerprint
  );

  const payload: Record<string, unknown> = {
    type: "build_archive",
    instrument_id: input.instrumentId,
    run_id: input.runId,
    destination_bucket: archiveBucket,
    destination_key: archiveKey,
    files: input.files.map((f) => ({
      key: f.s3Key,
      name: f.filename,
      source_bucket: f.sourceBucket,
    })),
  };
  if (input.jobId) payload.job_id = input.jobId;

  let res: Response;
  try {
    res = await fetch(lambda.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lambda.token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: `Failed to reach archive builder: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: await readLambdaErrorMessage(res),
    };
  }

  const body = (await res.json().catch(() => null)) as {
    archive_bucket?: string;
    archive_key?: string;
    size_bytes?: number;
  } | null;

  if (
    !body ||
    typeof body.archive_bucket !== "string" ||
    typeof body.archive_key !== "string" ||
    typeof body.size_bytes !== "number"
  ) {
    return {
      ok: false,
      status: 502,
      message: "Archive builder returned a malformed response",
    };
  }

  return {
    ok: true,
    archiveBucket: body.archive_bucket,
    archiveKey: body.archive_key,
    sizeBytes: body.size_bytes,
  };
}

// Pulls a human-readable error string off a non-2xx Lambda response. The
// builder always returns `{ "error": "..." }` JSON for build failures, so we
// prefer that field; if the body isn't JSON (e.g. a Function URL platform
// error before our handler ran) we fall back to the raw text. Trimmed and
// length-capped so a stray Python traceback doesn't end up rendered in a
// toast.
async function readLambdaErrorMessage(res: Response): Promise<string> {
  const fallback = `Archive builder returned ${res.status}`;
  const text = await res.text().catch(() => "");
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string" && parsed.error.trim()) {
      return parsed.error.trim().slice(0, 500);
    }
  } catch {
    // Body wasn't JSON — fall through and use the raw text.
  }
  return text.trim().slice(0, 500) || fallback;
}
