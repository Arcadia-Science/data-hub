"use client";

import { ArrowDownToLine, ArrowUpToLine, RotateCw, X } from "lucide-react";
import { useState } from "react";
import { BulkActionBarShell } from "@/components/bulk-action-bar-shell";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DismissFilesDialog, ReprocessFilesDialog } from "./file-bulk-dialogs";
import { type FileRef, useFileSelection } from "./file-selection-provider";
import {
  UploadReasonLine,
  WatcherGatedUploadButton,
} from "./watcher-gated-upload-button";

// ---------------------------------------------------------------------------
// Bulk action bar for the run files table, shown when at least one file is
// selected. `BulkActionBarShell` draws the floating card, the same one the
// runs table uses. The rollup rule is the runs table's too: an action shows
// only when every selected file supports it. Pending (Upload/Dismiss) and
// uploaded (Reprocess/Download) actions never overlap, so a mixed selection
// collapses to "Clear" only and the user has to narrow the selection before
// acting.
// ---------------------------------------------------------------------------

export interface FileBulkActionBarProps {
  isPending: boolean;
  onDismiss: (ids: number[]) => void;
  onDownload: (refs: FileRef[]) => void;
  onReprocess: (ids: number[]) => void;
  onUpload: (ids: number[]) => void;
}

export function FileBulkActionBar({
  isPending,
  onUpload,
  onDismiss,
  onReprocess,
  onDownload,
}: FileBulkActionBarProps) {
  const { state, actions, meta } = useFileSelection();
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reprocessOpen, setReprocessOpen] = useState(false);

  if (meta.count === 0) {
    return null;
  }

  const refs = Array.from(state.selected.values());
  const ids = refs.map((r) => r.id);
  const count = meta.count;
  const noun = count === 1 ? "file" : "files";

  return (
    <>
      <BulkActionBarShell
        ariaLabel="Actions for selected files"
        count={count}
        noun="file"
        onClear={() => actions.clear()}
        pending={isPending}
      >
        {meta.allCanUpload && (
          <>
            <UploadReasonLine />
            <WatcherGatedUploadButton
              className="gap-1.5"
              disabled={isPending}
              enabledTooltip={`Request upload for ${count} ${noun}`}
              onClick={() => onUpload(ids)}
              size="sm"
              type="button"
              variant="outline"
            >
              <ArrowUpToLine className="size-3.5" />
              Upload
            </WatcherGatedUploadButton>
          </>
        )}

        {meta.allCanDownload && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="gap-1.5"
                disabled={isPending}
                onClick={() => onDownload(refs)}
                size="sm"
                type="button"
                variant="outline"
              >
                <ArrowDownToLine className="size-3.5" />
                Download
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {count === 1
                ? "Download this file"
                : `Download ${count} files as one zip`}
            </TooltipContent>
          </Tooltip>
        )}

        {meta.allCanReprocess && (
          <Button
            className="gap-1.5"
            disabled={isPending}
            onClick={() => setReprocessOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <RotateCw className="size-3.5" />
            Reprocess
          </Button>
        )}

        {meta.allCanDismiss && (
          <Button
            className="gap-1.5 text-destructive hover:text-destructive"
            disabled={isPending}
            onClick={() => setDismissOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <X className="size-3.5" />
            Dismiss
          </Button>
        )}
      </BulkActionBarShell>

      <ReprocessFilesDialog
        count={count}
        onConfirm={() => onReprocess(ids)}
        onOpenChange={setReprocessOpen}
        open={reprocessOpen}
      />
      <DismissFilesDialog
        count={count}
        onConfirm={() => onDismiss(ids)}
        onOpenChange={setDismissOpen}
        open={dismissOpen}
      />
    </>
  );
}
