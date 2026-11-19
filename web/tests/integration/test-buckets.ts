// The S3 buckets the integration test server is started with
// (`global-setup.ts`). `POST …/runs/:runId/files` only accepts a file in the
// bucket for its category, so tests that register files send these names.
export const TEST_RAW_BUCKET = "test-raw-data-bucket";
export const TEST_PROCESSED_BUCKET = "test-processed-data-bucket";
