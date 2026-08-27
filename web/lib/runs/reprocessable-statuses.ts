import type { files, InstrumentType } from "@/lib/db/schema";
import { isProcessableInstrumentType } from "@/lib/instruments/processable-types";
import { isStalledProcessing } from "@/lib/runs/stalled-processing";

// Statuses eligible for POST /files/:id/reprocess (and run-level reprocess).
// `uploaded` covers a missed S3 trigger. Stalled `processing` is a separate
// `isStalledProcessing` check so in-flight work is not cancelled.
export const REPROCESSABLE_STATUSES = [
  "uploaded",
  "failed",
  "completed",
] as const;

const REPROCESSABLE_STATUS_SET = new Set<string>(REPROCESSABLE_STATUSES);

// Only the columns the predicate reads, taken from the `files` row so a typo
// in a category or status literal fails to compile.
export type ReprocessableFile = Pick<
  typeof files.$inferSelect,
  "category" | "deletedAt" | "processingStartedAt" | "s3Key" | "status"
> & {
  // When the server already decided staleness (run-page rows), use that so
  // the Reprocess button does not disagree with the first paint.
  stalledProcessing?: boolean;
};

export function canReprocessFile(
  file: ReprocessableFile,
  instrumentType: InstrumentType
): boolean {
  const eligibleStatus =
    REPROCESSABLE_STATUS_SET.has(file.status) ||
    (file.stalledProcessing ?? isStalledProcessing(file));
  return (
    file.category === "raw" &&
    file.deletedAt === null &&
    file.s3Key !== null &&
    eligibleStatus &&
    isProcessableInstrumentType(instrumentType)
  );
}
