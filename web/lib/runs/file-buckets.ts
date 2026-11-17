import type { files } from "@/lib/db/schema";
import type { RunFileBucket } from "@/lib/runs/run-status";

// The one place that says how each file status counts. Both tables are typed
// against every value of the `file_status` enum, so adding a status fails the
// build until it has a row in each.
//
// Client-safe and free of Drizzle values (the schema import is type-only), so
// `deriveRunStatus` and client components can read it. The SQL built from it
// lives in `file-buckets.sql.ts`.

export type FileStatus = (typeof files.$inferSelect)["status"];

// A `processing` file counts as in flight until the stall window passes, then
// as stalled (see `isStalledProcessing`). Every other status counts in one run
// status.
interface ProcessingAgeSplit {
  inFlight: RunFileBucket;
  stalled: RunFileBucket;
}

type RunBucketRule<S extends FileStatus> = S extends "processing"
  ? ProcessingAgeSplit
  : RunFileBucket;

// Which run status each file status feeds. `deriveRunStatus`, the runs-list
// status filter, the per-run counters and the files-table status filter all
// read this table.
export const RUN_BUCKET_BY_FILE_STATUS: {
  readonly [S in FileStatus]: RunBucketRule<S>;
} = {
  detected: "pending",
  upload_requested: "pending",
  uploaded: "uploaded",
  queued: "queued",
  processing: { inFlight: "processing", stalled: "stalled" },
  completed: "completed",
  failed: "failed",
};

// Whether a file's bytes have reached S3. A `pre_upload` file exists only on
// the instrument PC; every other file has been uploaded.
export type FileUploadStage = "pre_upload" | "in_s3";

export const UPLOAD_STAGE_BY_FILE_STATUS: {
  readonly [S in FileStatus]: FileUploadStage;
} = {
  detected: "pre_upload",
  upload_requested: "pre_upload",
  uploaded: "in_s3",
  queued: "in_s3",
  processing: "in_s3",
  completed: "in_s3",
  failed: "in_s3",
};

const ALL_FILE_STATUSES = Object.keys(
  UPLOAD_STAGE_BY_FILE_STATUS
) as FileStatus[];

function statusesAtStage(stage: FileUploadStage): FileStatus[] {
  return ALL_FILE_STATUSES.filter(
    (status) => UPLOAD_STAGE_BY_FILE_STATUS[status] === stage
  );
}

// Files still only on the instrument PC. These can be requested for upload,
// dismissed, or adopted by an upload that arrives later.
export const PRE_UPLOAD_FILE_STATUSES: readonly FileStatus[] =
  statusesAtStage("pre_upload");

// Files whose bytes are in S3. An upload for one of these is refused.
export const IN_S3_FILE_STATUSES: readonly FileStatus[] =
  statusesAtStage("in_s3");

export interface RunBucketSources {
  // Which halves of `processing` count here, split by the stall window.
  processing: ("inFlight" | "stalled")[];
  // File statuses that always count in the bucket.
  statuses: FileStatus[];
}

// The file rows that count toward `bucket`, read off the table above.
export function runBucketSources(bucket: RunFileBucket): RunBucketSources {
  const sources: RunBucketSources = { processing: [], statuses: [] };
  for (const status of ALL_FILE_STATUSES) {
    if (status === "processing") {
      const split = RUN_BUCKET_BY_FILE_STATUS.processing;
      if (split.inFlight === bucket) {
        sources.processing.push("inFlight");
      }
      if (split.stalled === bucket) {
        sources.processing.push("stalled");
      }
    } else if (RUN_BUCKET_BY_FILE_STATUS[status] === bucket) {
      sources.statuses.push(status);
    }
  }
  return sources;
}
