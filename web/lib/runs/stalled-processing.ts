import type { files } from "@/lib/db/schema";

// Lambda's hard limit is 900s (`infra/template.yaml`). Past this window a
// file still in `processing` means the processor died without reporting back.
export const STALLED_PROCESSING_AFTER_MS = 20 * 60 * 1000;

export type StalledProcessingFile = Pick<
  typeof files.$inferSelect,
  "status" | "processingStartedAt"
>;

export function isStalledProcessing(
  file: StalledProcessingFile,
  now: Date = new Date()
): boolean {
  if (file.status !== "processing") {
    return false;
  }
  // NULL predates the column, so the row is old by definition.
  if (file.processingStartedAt === null) {
    return true;
  }
  return (
    now.getTime() - file.processingStartedAt.getTime() >
    STALLED_PROCESSING_AFTER_MS
  );
}

export function stalledProcessingCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - STALLED_PROCESSING_AFTER_MS);
}

// Remaining wait before a still-in-flight file becomes reprocessable.
export function minutesUntilProcessingIsStalled(
  file: Pick<typeof files.$inferSelect, "processingStartedAt">,
  now: Date = new Date()
): number {
  const started = file.processingStartedAt ?? now;
  const remainingMs =
    STALLED_PROCESSING_AFTER_MS - (now.getTime() - started.getTime());
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}
