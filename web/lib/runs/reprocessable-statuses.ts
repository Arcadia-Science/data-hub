import type { files, InstrumentType } from "@/lib/db/schema";
import { isProcessableInstrumentType } from "@/lib/instruments/processable-types";

// Statuses eligible for POST /files/:id/reprocess (and run-level reprocess).
// `uploaded` covers a missed S3 trigger. Stalled `processing` arrives as the
// `stalledProcessing` flag instead, so in-flight work is never cancelled.
export const REPROCESSABLE_STATUSES = [
  "uploaded",
  "failed",
  "completed",
] as const;

const REPROCESSABLE_STATUS_SET = new Set<string>(REPROCESSABLE_STATUSES);

// Only the columns the predicate reads, taken from the `files` row so a typo
// in a category or status literal fails to compile.
//
// This is the render-time gate for the Reprocess button, so it takes the
// server's stall verdict rather than reading the clock itself: recomputing on
// the client would let the button disagree with the status column after
// hydration. The API path re-checks with `isStalledProcessing` before acting.
export type ReprocessableFile = Pick<
  typeof files.$inferSelect,
  "category" | "deletedAt" | "s3Key" | "status"
> & { stalledProcessing: boolean };

export function canReprocessFile(
  file: ReprocessableFile,
  instrumentType: InstrumentType
): boolean {
  const eligibleStatus =
    REPROCESSABLE_STATUS_SET.has(file.status) || file.stalledProcessing;
  return (
    file.category === "raw" &&
    file.deletedAt === null &&
    file.s3Key !== null &&
    eligibleStatus &&
    isProcessableInstrumentType(instrumentType)
  );
}
