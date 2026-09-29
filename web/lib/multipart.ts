// Files at or above the threshold upload as parts. The server decides, so
// this can change without a watcher release. Tests set the env vars so they
// can exercise the path with a small file; production leaves them unset.

export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const MULTIPART_PART_SIZE_BYTES = 64 * 1024 * 1024;
// S3 rejects a single PutObject larger than 5 GiB.
export const SINGLE_PUT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const MULTIPART_MAX_PARTS = 10_000;
// Every part except the last must be at least this big.
export const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
// Part URLs are signed with role credentials that can expire within minutes,
// so the watcher fetches a few at a time instead of all of them up front.
export const PART_URL_BATCH_LIMIT = 8;
export const PART_URL_EXPIRY_SECONDS = 15 * 60;

function envBytes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function multipartThresholdBytes(): number {
  return envBytes("MULTIPART_THRESHOLD_BYTES", MULTIPART_THRESHOLD_BYTES);
}

export function multipartPartSizeBytes(): number {
  const configured = envBytes(
    "MULTIPART_PART_SIZE_BYTES",
    MULTIPART_PART_SIZE_BYTES
  );
  const size = Math.max(configured, 1);
  // Tests set a tiny part size. S3 rejects a part under 5 MiB, so that
  // override is only honored while the local stand-in is actually in use.
  // The conditions match `mirrorRootForMultipart`.
  if (standInServesParts()) {
    return size;
  }
  return Math.max(size, MULTIPART_MIN_PART_BYTES);
}

function standInServesParts(): boolean {
  if (process.env.NODE_ENV !== "production" && process.env.LOCAL_S3_MIRROR) {
    return true;
  }
  if (process.env.VERCEL) {
    return false;
  }
  return Boolean(process.env.INTEGRATION_TEST_S3_MIRROR);
}

export function planMultipartUpload(sizeBytes: number): {
  partSize: number;
  partCount: number;
} {
  let partSize = multipartPartSizeBytes();
  let partCount = Math.ceil(sizeBytes / partSize);
  if (partCount > MULTIPART_MAX_PARTS) {
    partSize = Math.ceil(sizeBytes / MULTIPART_MAX_PARTS);
    partCount = Math.ceil(sizeBytes / partSize);
  }
  return { partSize, partCount };
}
