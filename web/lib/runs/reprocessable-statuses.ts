import type { files, InstrumentType } from "@/lib/db/schema";
import { isProcessableInstrumentType } from "@/lib/instruments/processable-types";

// Statuses eligible for POST /files/:id/reprocess (and run-level reprocess).
// Includes `uploaded` so stuck S3 uploads can be kicked when the Lambda
// trigger never fired. Client-safe — imported by UI tables and the API.
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
  "category" | "deletedAt" | "s3Key" | "status"
>;

export function canReprocessFile(
  file: ReprocessableFile,
  instrumentType: InstrumentType
): boolean {
  return (
    file.category === "raw" &&
    file.deletedAt === null &&
    file.s3Key !== null &&
    REPROCESSABLE_STATUS_SET.has(file.status) &&
    isProcessableInstrumentType(instrumentType)
  );
}
