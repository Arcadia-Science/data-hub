// Statuses eligible for POST /files/:id/reprocess (and run-level reprocess).
// Includes `uploaded` so stuck S3 uploads can be kicked when the Lambda
// trigger never fired. Client-safe — imported by UI tables and the API.
export const REPROCESSABLE_STATUSES = [
  "uploaded",
  "failed",
  "completed",
] as const;
