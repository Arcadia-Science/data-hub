// Most raw files that may be processing at once across all of Data Hub. Each
// processing file is a Lambda copy that calls back into the web app and the
// database. Starting every file of a large run together ran Postgres out of
// connections, so reprocessing queues files and starts them up to this limit.
export const DEFAULT_PROCESSING_CONCURRENCY_LIMIT = 10;

// Read at call time so API/MCP see the current Vercel value. Anything that is
// not a whole number above zero keeps the default, so a typo in the variable
// cannot stop the queue from starting files.
export function processingConcurrencyLimit(): number {
  const raw = process.env.PROCESSING_CONCURRENCY_LIMIT;
  if (raw === undefined) {
    return DEFAULT_PROCESSING_CONCURRENCY_LIMIT;
  }
  const limit = Number(raw.trim());
  if (!Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_PROCESSING_CONCURRENCY_LIMIT;
  }
  return limit;
}
