import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { files } from "@/lib/db/schema";
import { runBucketSources } from "@/lib/runs/file-buckets";
import type { RunFileBucket } from "@/lib/runs/run-status";
import {
  inFlightProcessingSql,
  stalledProcessingSql,
} from "@/lib/runs/stalled-processing.sql";

// SQL twin of `RUN_BUCKET_BY_FILE_STATUS`, kept apart so client bundles that
// read the table don't pull in Drizzle.

// True for a `files` row that counts toward `bucket` in its run's status. The
// caller adds the row's scope (raw, not deleted). `now` places the stall cutoff
// for `processing` rows.
export function fileInRunBucketSql(bucket: RunFileBucket, now: Date): SQL {
  const sources = runBucketSources(bucket);
  const conditions: SQL[] = [];
  if (sources.statuses.length > 0) {
    conditions.push(inArray(files.status, sources.statuses));
  }
  if (sources.detected.includes("autoUploadExpected")) {
    conditions.push(
      and(
        eq(files.status, "detected"),
        isNotNull(files.autoUploadExpectedAt)
      ) as SQL
    );
  }
  if (sources.detected.includes("otherwise")) {
    conditions.push(
      and(
        eq(files.status, "detected"),
        isNull(files.autoUploadExpectedAt)
      ) as SQL
    );
  }
  if (sources.processing.includes("inFlight")) {
    conditions.push(inFlightProcessingSql(now));
  }
  if (sources.processing.includes("stalled")) {
    conditions.push(stalledProcessingSql(now));
  }
  if (conditions.length === 0) {
    // No file status feeds this bucket. A unit test keeps this from happening.
    return sql`false`;
  }
  if (conditions.length === 1) {
    return conditions[0];
  }
  return sql`(${sql.join(conditions, sql` or `)})`;
}

// What the deprecated "pending" run status counted: files still on the
// instrument PC that are waiting for an upload or a request. Leaves out
// `upload_failed` files.
export function filePendingUploadSql(now: Date): SQL {
  return sql`(${fileInRunBucketSql("waiting_upload", now)} or ${fileInRunBucketSql("not_uploaded", now)})`;
}
