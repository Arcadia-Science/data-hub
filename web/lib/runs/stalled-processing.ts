import type { files } from "@/lib/db/schema";

// Lambda's hard limit is 900s (`infra/template.yaml`). Default is 5 minutes
// past that so a live invoke is not treated as stalled.
export const DEFAULT_STALLED_PROCESSING_AFTER_MS = 20 * 60 * 1000;

// Read at call time so API/MCP see the current Vercel value. Client code
// that imports this module keeps the default: the var is not `NEXT_PUBLIC_`,
// and the files table already trusts the server-stamped `stalledProcessing`.
export function stalledProcessingAfterMs(): number {
  const raw = process.env.STALLED_PROCESSING_AFTER_MINUTES;
  if (raw === undefined) {
    return DEFAULT_STALLED_PROCESSING_AFTER_MS;
  }
  const minutes = Number(raw.trim());
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return DEFAULT_STALLED_PROCESSING_AFTER_MS;
  }
  return minutes * 60 * 1000;
}

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
    stalledProcessingAfterMs()
  );
}

export function stalledProcessingCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - stalledProcessingAfterMs());
}

// Remaining wait before a still-in-flight file becomes reprocessable.
export function minutesUntilProcessingIsStalled(
  file: Pick<typeof files.$inferSelect, "processingStartedAt">,
  now: Date = new Date()
): number {
  const started = file.processingStartedAt ?? now;
  const remainingMs =
    stalledProcessingAfterMs() - (now.getTime() - started.getTime());
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}
