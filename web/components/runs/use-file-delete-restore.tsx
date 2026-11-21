"use client";

import { useRouter } from "next/navigation";
import {
  type ReactNode,
  type TransitionStartFunction,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { fetchLinkedFiles, fileBatches } from "@/lib/runs/run-file-requests";
import {
  FileActionDialog,
  type FileTarget,
  type LinkedFilesState,
} from "./file-action-dialog";
import {
  deleteFilesAndOfferUndo,
  restoreFilesAndReport,
} from "./file-action-flows";
import { useBumpReportItems } from "./report-items-provider";

interface DialogState {
  files: FileTarget[];
  linked: LinkedFilesState;
  verb: "delete" | "restore";
}

interface Callbacks {
  // Runs when the person confirms, before the request.
  onConfirmed?: () => void;
  // Runs when the request is done, whatever came of it.
  onSettled?: () => void;
}

/**
 * Deleting and restoring files of a run, for every place that offers them: the
 * files table's bar and the file window. `askDelete` opens the delete dialog,
 * which looks up the linked files while it is open. `askRestore` looks them up
 * first and restores at once when no deleted file is linked, and opens the
 * restore dialog when there are some. Render `dialogs` where the dialogs can
 * open from, inside the file window for the window's own, so the window stays
 * open behind them.
 *
 * Requests run in `startAction`, so the caller's buttons wait for them.
 */
export function useFileDeleteRestore({
  instrumentId,
  runId,
  startAction,
}: {
  instrumentId: string;
  runId: string;
  startAction: TransitionStartFunction;
}): {
  askDelete: (files: FileTarget[], callbacks?: Callbacks) => void;
  askRestore: (files: FileTarget[], callbacks?: Callbacks) => void;
  dialogs: ReactNode;
} {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Kept after the dialog closes, so it can fade out with its content.
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const callbacksRef = useRef<Callbacks>({});
  // Stops a lookup that finishes after its dialog closed from filling a newer
  // one.
  const lookup = useRef<AbortController | null>(null);

  const onFilesChanged = useBumpReportItems();

  const target = {
    instrumentId,
    runId,
    onFilesChanged,
    refresh: () => router.refresh(),
  };

  function askDelete(files: FileTarget[], callbacks: Callbacks = {}) {
    if (files.length === 0) {
      return;
    }
    callbacksRef.current = callbacks;
    lookup.current?.abort();
    const controller = new AbortController();
    lookup.current = controller;
    setDialog({ verb: "delete", files, linked: { status: "loading" } });
    setOpen(true);
    fetchLinkedFiles(
      instrumentId,
      runId,
      fileBatches(files),
      "delete",
      controller.signal
    ).then((linked) => {
      if (controller.signal.aborted) {
        return;
      }
      setDialog((current) =>
        current === null
          ? current
          : {
              ...current,
              linked:
                linked === null
                  ? { status: "failed" }
                  : { status: "ready", files: linked },
            }
      );
    });
  }

  function askRestore(files: FileTarget[], callbacks: Callbacks = {}) {
    if (files.length === 0) {
      return;
    }
    callbacksRef.current = callbacks;
    const batches = fileBatches(files);
    startAction(async () => {
      const linked = await fetchLinkedFiles(
        instrumentId,
        runId,
        batches,
        "restore"
      );
      if (linked === null) {
        // Restoring now could leave files behind that were meant to come back.
        toast.error("Couldn’t check for linked files. Try again.");
        return;
      }
      if (linked.length > 0) {
        setDialog({
          verb: "restore",
          files,
          linked: { status: "ready", files: linked },
        });
        setOpen(true);
        return;
      }
      callbacks.onConfirmed?.();
      await restoreFilesAndReport({
        ...target,
        batches,
        includeLinked: false,
      });
      callbacks.onSettled?.();
    });
  }

  function confirm(includeLinked: boolean) {
    if (dialog === null) {
      return;
    }
    const { verb, files } = dialog;
    const { onConfirmed, onSettled } = callbacksRef.current;
    // The same batches the dialog's lookup used, so what it listed is what
    // goes along.
    const request = { ...target, batches: fileBatches(files), includeLinked };
    onConfirmed?.();
    startAction(async () => {
      if (verb === "delete") {
        await deleteFilesAndOfferUndo(request);
      } else {
        await restoreFilesAndReport(request);
      }
      onSettled?.();
    });
  }

  const dialogs = dialog ? (
    <FileActionDialog
      files={dialog.files}
      linked={dialog.linked}
      onConfirm={confirm}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          lookup.current?.abort();
        }
      }}
      open={open}
      verb={dialog.verb}
    />
  ) : null;

  return { askDelete, askRestore, dialogs };
}
