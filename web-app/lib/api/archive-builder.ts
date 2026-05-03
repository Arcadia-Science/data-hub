import { getS3ArchivesBucket } from "@/lib/s3";
import crypto from "node:crypto";

// Threshold below which we await the Lambda response inside the request
// handler and 302 directly. Above this size, we kick the build into the
// background and return a job ID so the UI can poll.
//
// Tuned to ~80% of Vercel Pro's 5 minute function cap at ~500 MB/s in-region
// S3-to-S3 throughput so even a slow source bucket has headroom.
const DEFAULT_SYNC_THRESHOLD_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB

export function getSyncArchiveThresholdBytes(): number {
  const raw = process.env.SYNC_ARCHIVE_THRESHOLD_GB;
  if (!raw) return DEFAULT_SYNC_THRESHOLD_BYTES;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SYNC_THRESHOLD_BYTES;
  }
  return Math.floor(parsed * 1024 * 1024 * 1024);
}

export type ArchiveFileInput = {
  id: number;
  s3Key: string;
  filename: string;
};

// Stable hash of the (file_id, s3_key) pairs that compose an archive. Adding
// or removing a file changes the fingerprint, so the route never serves a
// stale zip after a run's contents change. Sorting by id keeps the value
// stable regardless of database ordering.
export function fingerprintFiles(files: ArchiveFileInput[]): string {
  const canonical = [...files]
    .map((f) => `${f.id}:${f.s3Key}`)
    .sort()
    .join("|");
  return crypto.createHash("sha1").update(canonical).digest("hex");
}

export function getArchiveKey(
  instrumentId: string,
  runId: string,
  fingerprint: string
): string {
  // Keep the instrument and run id in the path so a stray `aws s3 ls` is
  // self-explanatory. The fingerprint disambiguates filtered ("?file_ids=")
  // archives from full-run archives.
  return `runs/${instrumentId}/${runId}/${fingerprint}.zip`;
}

type LambdaConfig = { url: string; token: string };

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
  sourceBucket: string;
  files: { s3Key: string; filename: string }[];
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
    source_bucket: input.sourceBucket,
    destination_bucket: archiveBucket,
    destination_key: archiveKey,
    files: input.files.map((f) => ({ key: f.s3Key, name: f.filename })),
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
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      message: text || `Archive builder returned ${res.status}`,
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
