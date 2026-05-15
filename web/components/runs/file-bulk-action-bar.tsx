"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ArrowDownToLine, RotateCw, Upload, X } from "lucide-react";

import { type FileRef, useFileSelection } from "./file-selection-provider";
import { WatcherGatedUploadButton } from "./watcher-gated-upload-button";

// ---------------------------------------------------------------------------
// Bulk action bar shown above the run files table when at least one file is
// selected. Mirrors RunBulkActionBar (instrument runs) in styling and in the
// "show only when every selected file supports it" rollup rule — pending
// (Upload/Dismiss) and uploaded (Reprocess/Download) actions never overlap,
// so a mixed selection collapses to "Clear" only and the user has to
// narrow the selection before acting.
// ---------------------------------------------------------------------------

export type FileBulkActionBarProps = {
  isPending: boolean;
  onUpload: (ids: number[]) => void;
  onDismiss: (ids: number[]) => void;
  onReprocess: (ids: number[]) => void;
  onDownload: (refs: FileRef[]) => void;
};

export function FileBulkActionBar({
  isPending,
  onUpload,
  onDismiss,
  onReprocess,
  onDownload,
}: FileBulkActionBarProps) {
  const { state, actions, meta } = useFileSelection();

  if (meta.count === 0) return null;

  const refs = Array.from(state.selected.values());
  const ids = refs.map((r) => r.id);
  const count = meta.count;
  const noun = count === 1 ? "file" : "files";

  return (
    <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
      <div className="text-sm">
        <span className="font-medium">{count}</span>{" "}
        <span className="text-muted-foreground">{noun} selected</span>
      </div>
      <div className="flex items-center gap-2">
        {meta.allCanUpload && (
          <Tooltip>
            <TooltipTrigger asChild>
              <WatcherGatedUploadButton
                type="button"
                variant="default"
                size="sm"
                disabled={isPending}
                onClick={() => onUpload(ids)}
                className="h-7 gap-1.5 text-xs"
              >
                <Upload className="size-3.5" />
                Upload
              </WatcherGatedUploadButton>
            </TooltipTrigger>
            <TooltipContent>
              Request upload for {count} {noun}
            </TooltipContent>
          </Tooltip>
        )}

        {meta.allCanDismiss && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPending}
                className="h-7 gap-1.5 text-xs"
              >
                <X className="size-3.5" />
                Dismiss
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Dismiss {count} {noun}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  The selected files will be soft-deleted. The watcher will skip
                  them on future scans.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => onDismiss(ids)}>
                  Dismiss
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {meta.allCanReprocess && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPending}
                className="h-7 gap-1.5 text-xs"
              >
                <RotateCw className="size-3.5" />
                Reprocess
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Reprocess {count} {noun}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Each selected file will be re-sent to the Lambda function for
                  reprocessing. Any existing report data for these files will be
                  cleared.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => onReprocess(ids)}>
                  Reprocess
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {meta.allCanDownload && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onDownload(refs)}
                className="h-7 gap-1.5 text-xs"
              >
                <ArrowDownToLine className="size-3.5" />
                Download
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Download {count} {noun}
            </TooltipContent>
          </Tooltip>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => actions.clear()}
          className="h-7 text-xs"
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
