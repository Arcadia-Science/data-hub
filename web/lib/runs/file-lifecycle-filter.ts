// The status options the run-detail files table offers. Not the `files.status`
// DB enum: "pending" collapses `detected` + `upload_requested`, and the single
// `processing` status splits into "processing" (in flight) and "stalled" (past
// the cutoff). `fileStatusCondition` in `lib/api/instrument-runs.ts` turns each
// option into SQL.
//
// Client-safe and free of Drizzle so the nuqs parser, the toolbar, and the
// archive route can all validate against the same list.
export const FILES_LIFECYCLE_FILTER_VALUES = [
  "pending",
  "uploaded",
  "processing",
  "stalled",
  "completed",
  "failed",
] as const;

export type FilesLifecycleFilter =
  (typeof FILES_LIFECYCLE_FILTER_VALUES)[number];
