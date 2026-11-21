import { toast } from "sonner";
import { fileActionMessage } from "@/lib/runs/file-action-copy";
import {
  deleteRunFiles,
  type FileActionTally,
  inBatches,
  restoreRunFiles,
} from "@/lib/runs/run-file-requests";

// What happens after a person confirms a delete or a restore of run files: the
// request, the message that says how it went, and the page refresh. The files
// table's bar, the file window and the "couldn't upload" notice share these, so
// each says the same things and offers the same Undo.

// How long the "Deleted N files" message stays, with its Undo.
export const UNDO_DELETE_MS = 10_000;

interface RunFilesTarget {
  instrumentId: string;
  // Runs when a request deleted or restored at least one file, before the
  // refresh, so the report on the page can reload its items.
  onFilesChanged?: () => void;
  // Refreshes the page's data, as `router.refresh` does.
  refresh: () => void;
  runId: string;
}

function reportRestore(tally: FileActionTally) {
  const message = fileActionMessage("restore", tally);
  const description =
    tally.failed > 0 ? (tally.message ?? undefined) : undefined;
  if (message.kind === "success") {
    toast.success(message.text);
  } else if (message.kind === "warning") {
    toast.warning(message.text, { description });
  } else {
    toast.error(message.text, { description });
  }
}

// The files to act on, as the requests send them: `fileBatches` keeps each
// folder's files together for the linked files, and `inBatches` does for a
// plain list of IDs.
type Batches = readonly (readonly number[])[];

/**
 * Restores the files in `batches`, tells the person how it went, and refreshes
 * the page. `includeLinked` takes the deleted files linked to them along.
 */
export async function restoreFilesAndReport({
  batches,
  includeLinked,
  ...target
}: RunFilesTarget & {
  batches: Batches;
  includeLinked: boolean;
}): Promise<FileActionTally> {
  const tally = await restoreRunFiles(
    target.instrumentId,
    target.runId,
    batches,
    includeLinked
  );
  reportRestore(tally);
  if (tally.done > 0) {
    target.onFilesChanged?.();
  }
  target.refresh();
  return tally;
}

/**
 * Deletes the files in `batches` (and their linked files when `includeLinked`
 * is set), tells the person how it went, and refreshes the page. A delete that
 * removed something says so with an Undo for ten seconds. Undo restores exactly
 * the files this delete removed, the requested ones and the linked ones, and
 * leaves their other linked files alone.
 */
export async function deleteFilesAndOfferUndo({
  batches,
  includeLinked,
  ...target
}: RunFilesTarget & {
  batches: Batches;
  includeLinked: boolean;
}) {
  const tally = await deleteRunFiles(
    target.instrumentId,
    target.runId,
    batches,
    includeLinked
  );
  const message = fileActionMessage("delete", tally);
  const description =
    tally.failed > 0 ? (tally.message ?? undefined) : undefined;
  if (message.kind === "error") {
    toast.error(message.text, { description });
  } else {
    const action =
      tally.removedIds.length === 0
        ? undefined
        : {
            label: "Undo",
            onClick: () => {
              void restoreFilesAndReport({
                ...target,
                batches: inBatches(tally.removedIds),
                includeLinked: false,
              });
            },
          };
    const options = { action, description, duration: UNDO_DELETE_MS };
    if (message.kind === "success") {
      toast.success(message.text, options);
    } else {
      toast.warning(message.text, options);
    }
  }
  if (tally.removedIds.length > 0) {
    target.onFilesChanged?.();
  }
  target.refresh();
  return tally;
}
