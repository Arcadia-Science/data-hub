// Split from `run-archive` so this stays importable without `@/lib/db`, which
// throws at import when `DATABASE_URL` is unset (e.g. the no-Postgres suite).

export const ARCHIVE_BUILD_RETRY_AFTER_SECONDS = 5;
export const ARCHIVE_BUILD_RETRY_AFTER_MAX_SECONDS = 30;

// Two terms because build time is dominated by either per-object GET latency
// (many small files) or throughput (a few large files). Rough guesses; the
// floor/cap above bound the error.
const ARCHIVE_BUILD_BASE_SECONDS = 3;
const ARCHIVE_BUILD_SECONDS_PER_FILE = 0.005;
const ARCHIVE_BUILD_BYTES_PER_SECOND = 200 * 1024 * 1024;

export function estimateRetryAfterSeconds(input: {
  fileCount: number;
  totalBytes: number;
}): number {
  // NULL file sizes (unsized uploads) sum to 0 bytes, so they only count
  // toward the per-file term, not throughput.
  const estimate =
    ARCHIVE_BUILD_BASE_SECONDS +
    input.fileCount * ARCHIVE_BUILD_SECONDS_PER_FILE +
    input.totalBytes / ARCHIVE_BUILD_BYTES_PER_SECOND;
  const rounded = Math.ceil(estimate);
  return Math.min(
    ARCHIVE_BUILD_RETRY_AFTER_MAX_SECONDS,
    Math.max(ARCHIVE_BUILD_RETRY_AFTER_SECONDS, rounded)
  );
}
