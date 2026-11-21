import type { files } from "@/lib/db/schema";

// Only the columns the rule reads, taken from the `files` row.
export type DeletableFile = Pick<
  typeof files.$inferSelect,
  "deletedAt" | "status"
> & { stalledProcessing: boolean };

/**
 * Whether the Delete button is offered for a file: any active file, except one
 * that is queued or being processed, because the processor is about to write
 * to it. A file whose processing stalled has no processor behind it any more,
 * so it can go. The API refuses the same files (`refusedWhileProcessing` in
 * `lib/api/file-deletion.ts`), and takes the server's stall verdict, as
 * `canReprocessFile` does.
 */
export function canDeleteFile(file: DeletableFile): boolean {
  if (file.deletedAt !== null) {
    return false;
  }
  if (file.status === "queued") {
    return false;
  }
  return !(file.status === "processing" && !file.stalledProcessing);
}
