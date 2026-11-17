// The status options the run-detail files table offers. They are the run-status
// buckets, not the `files.status` DB enum: "waiting_upload" covers requested
// files and files the watcher will upload itself, `detected` splits into
// "waiting_upload" and "not_uploaded" on the auto-upload mark, and
// `processing` splits into "processing" (in flight) and "stalled" (past the
// cutoff). `fileStatusCondition` in `lib/api/instrument-runs.ts` turns each
// option into SQL.
//
// Client-safe and free of Drizzle so the nuqs parser, the toolbar, and the
// archive route can all validate against the same list.
export const FILES_LIFECYCLE_FILTER_VALUES = [
  "not_uploaded",
  "waiting_upload",
  "upload_failed",
  "uploaded",
  "queued",
  "processing",
  "stalled",
  "completed",
  "failed",
] as const;

export type FilesLifecycleFilter =
  (typeof FILES_LIFECYCLE_FILTER_VALUES)[number];
