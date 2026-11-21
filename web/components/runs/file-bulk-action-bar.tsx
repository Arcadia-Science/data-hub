"use client";

import {
  ArrowDownToLine,
  ArrowUpToLine,
  RotateCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { BulkActionBarShell } from "@/components/bulk-action-bar-shell";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { FileTarget } from "./file-action-dialog";
import { ReprocessFilesDialog } from "./file-bulk-dialogs";
import { type FileRef, useFileSelection } from "./file-selection-provider";
import {
  UploadReasonLine,
  WatcherGatedUploadButton,
} from "./watcher-gated-upload-button";

// ---------------------------------------------------------------------------
// Bulk action bar for the run files table, shown when at least one file is
// selected. `BulkActionBarShell` draws the floating card, the same one the
// runs table uses. The rollup rule is the runs table's too: an action shows
// only when every selected file supports it, in the order Upload, Download,
// Reprocess, Delete. When every selected file is deleted the bar offers Restore
// instead. Pending (Upload) and uploaded (Reprocess/Download) actions never
// overlap, so a selection that mixes them offers only Delete, which both
// allow, and one that mixes active and deleted files collapses to "Clear" only,
// so the user has to narrow the selection before acting.
// ---------------------------------------------------------------------------

export interface FileBulkActionBarProps {
  isPending: boolean;
  // Delete and Restore open a dialog (or restore at once) that the caller owns.
  onDelete: (files: FileTarget[]) => void;
  onDownload: (refs: FileRef[]) => void;
  onReprocess: (ids: number[]) => void;
  onRestore: (files: FileTarget[]) => void;
  onUpload: (ids: number[]) => void;
}

export function FileBulkActionBar({
  isPending,
  onUpload,
  onDelete,
  onReprocess,
  onRestore,
  onDownload,
}: FileBulkActionBarProps) {
  const { state, actions, meta } = useFileSelection();
  const [reprocessOpen, setReprocessOpen] = useState(false);

  if (meta.count === 0) {
    return null;
  }

  const refs = Array.from(state.selected.values());
  const ids = refs.map((r) => r.id);
  const count = meta.count;
  const noun = count === 1 ? "file" : "files";
  const offered = new Set(meta.bar.actions);
  const targets: FileTarget[] = refs.map((ref) => ({
    id: ref.id,
    filename: ref.filename,
    relativePath: ref.relativePath,
    sizeBytes: ref.sizeBytes,
  }));

  return (
    <>
      <BulkActionBarShell
        ariaLabel="Actions for selected files"
        count={count}
        noun={meta.bar.noun}
        onClear={() => actions.clear()}
        pending={isPending}
      >
        {offered.has("upload") && (
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

        {offered.has("download") && (
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

        {offered.has("reprocess") && (
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

        {offered.has("delete") && (
          <Button
            className="gap-1.5 text-destructive hover:text-destructive"
            disabled={isPending}
            onClick={() => onDelete(targets)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
        )}

        {offered.has("restore") && (
          <Button
            className="gap-1.5"
            disabled={isPending}
            onClick={() => onRestore(targets)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Undo2 className="size-3.5" />
            Restore
          </Button>
        )}
      </BulkActionBarShell>

      <ReprocessFilesDialog
        count={count}
        onConfirm={() => onReprocess(ids)}
        onOpenChange={setReprocessOpen}
        open={reprocessOpen}
      />
    </>
  );
}
