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
// as stalled (see `isStalledProcessing`).
interface ProcessingAgeSplit {
  inFlight: RunFileBucket;
  stalled: RunFileBucket;
}

// A `detected` file counts as waiting when the watcher that reported it said it
// will upload it itself (`auto_upload_expected_at` is set), and as not uploaded
// otherwise.
interface AutoUploadMarkSplit {
  autoUploadExpected: RunFileBucket;
  otherwise: RunFileBucket;
}

type RunBucketRule<S extends FileStatus> = S extends "processing"
  ? ProcessingAgeSplit
  : S extends "detected"
    ? AutoUploadMarkSplit
    : RunFileBucket;

// Which run status each file status feeds. `deriveRunStatus`, the runs-list
// status filter, the per-run counters and the files-table status filter all
// read this table.
export const RUN_BUCKET_BY_FILE_STATUS: {
  readonly [S in FileStatus]: RunBucketRule<S>;
} = {
  detected: { autoUploadExpected: "waiting_upload", otherwise: "not_uploaded" },
  upload_requested: "waiting_upload",
  upload_failed: "upload_failed",
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
  upload_failed: "pre_upload",
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

// Files someone can request for upload, from a row, a bulk selection or
// "Upload all": on the instrument PC and not requested already.
export const REQUESTABLE_FILE_STATUSES: readonly FileStatus[] =
  PRE_UPLOAD_FILE_STATUSES.filter((status) => status !== "upload_requested");

export function isRequestableFileStatus(status: FileStatus): boolean {
  return REQUESTABLE_FILE_STATUSES.includes(status);
}

export interface RunBucketSources {
  // Which halves of `detected` count here, split by the auto-upload mark.
  detected: (keyof AutoUploadMarkSplit)[];
  // Which halves of `processing` count here, split by the stall window.
  processing: (keyof ProcessingAgeSplit)[];
  // File statuses that always count in the bucket.
  statuses: FileStatus[];
}

// The file rows that count toward `bucket`, read off the table above.
export function runBucketSources(bucket: RunFileBucket): RunBucketSources {
  const sources: RunBucketSources = {
    detected: [],
    processing: [],
    statuses: [],
  };
  for (const status of ALL_FILE_STATUSES) {
    if (status === "processing") {
      const split = RUN_BUCKET_BY_FILE_STATUS.processing;
      if (split.inFlight === bucket) {
        sources.processing.push("inFlight");
      }
      if (split.stalled === bucket) {
        sources.processing.push("stalled");
      }
    } else if (status === "detected") {
      const split = RUN_BUCKET_BY_FILE_STATUS.detected;
      if (split.autoUploadExpected === bucket) {
        sources.detected.push("autoUploadExpected");
      }
      if (split.otherwise === bucket) {
        sources.detected.push("otherwise");
      }
    } else if (RUN_BUCKET_BY_FILE_STATUS[status] === bucket) {
      sources.statuses.push(status);
    }
  }
  return sources;
}

// The run status one file row feeds. Mirrors `fileInRunBucketSql`, for code
// that already holds the row.
export function runBucketForFile(file: {
  autoUploadExpectedAt: Date | string | null;
  stalledProcessing: boolean;
  status: FileStatus;
}): RunFileBucket {
  if (file.status === "processing") {
    const split = RUN_BUCKET_BY_FILE_STATUS.processing;
    return file.stalledProcessing ? split.stalled : split.inFlight;
  }
  if (file.status === "detected") {
    const split = RUN_BUCKET_BY_FILE_STATUS.detected;
    return file.autoUploadExpectedAt === null
      ? split.otherwise
      : split.autoUploadExpected;
  }
  return RUN_BUCKET_BY_FILE_STATUS[file.status];
}
