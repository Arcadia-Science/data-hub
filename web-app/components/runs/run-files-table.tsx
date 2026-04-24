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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RunFile } from "@/lib/api/instrument-runs";
import { formatDateTime } from "@/lib/date";
import { formatBytes } from "@/lib/utils";
import { Download, Loader2, RotateCw, Upload, X } from "lucide-react";
import {
  FileSelectAllCheckbox,
  FileSelectCheckbox,
} from "./file-select-checkbox";
import { buildFileRef, useFileSelection } from "./file-selection-provider";
import { WatcherGatedUploadButton } from "./watcher-gated-upload-button";

const DOWNLOADABLE_STATUSES = new Set([
  "uploaded",
  "processing",
  "completed",
  "failed",
]);

const REPROCESSABLE_STATUSES = new Set(["completed", "failed"]);

export function statusLabel(file: RunFile): string {
  if (file.deletedAt !== null) return "Dismissed";
  switch (file.status) {
    case "detected":
      return "Pending";
    case "upload_requested":
      return "Uploading";
    case "uploaded":
      return "Uploaded";
    case "processing":
      return "Processing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return file.status;
  }
}

function StatusBadge({ file }: { file: RunFile }) {
  const label = statusLabel(file);

  switch (label) {
    case "Pending":
      return (
        <Badge
          variant="outline"
          className="border-amber-500/40 bg-amber-500/10 text-amber-400"
        >
          {label}
        </Badge>
      );
    case "Uploading":
      return (
        <Badge
          variant="outline"
          className="gap-1 border-sky-500/40 bg-sky-500/10 text-sky-400"
        >
          <Loader2 className="size-3 animate-spin" />
          {label}
        </Badge>
      );
    case "Uploaded":
      return <Badge variant="outline">{label}</Badge>;
    case "Processing":
      return (
        <Badge
          variant="outline"
          className="gap-1 border-blue-500/40 bg-blue-500/10 text-blue-400"
        >
          <Loader2 className="size-3 animate-spin" />
          {label}
        </Badge>
      );
    case "Completed":
      return (
        <Badge
          variant="outline"
          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
        >
          {label}
        </Badge>
      );
    case "Failed": {
      const badge = <Badge variant="destructive">{label}</Badge>;
      if (!file.errorMessage) return badge;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>{badge}</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-sm">
            {file.errorMessage}
          </TooltipContent>
        </Tooltip>
      );
    }
    case "Dismissed":
      return (
        <Badge variant="secondary" className="opacity-60">
          {label}
        </Badge>
      );
    default:
      return <Badge variant="secondary">{label}</Badge>;
  }
}

// ---------------------------------------------------------------------------
// Shared table pieces used by both the editable and read-only variants.
// ---------------------------------------------------------------------------

function FileColumnHeaders() {
  return (
    <>
      <TableHead className="text-sm font-medium text-muted-foreground">
        File name
      </TableHead>
      <TableHead className="text-sm font-medium text-muted-foreground">
        Type
      </TableHead>
      <TableHead className="text-sm font-medium text-muted-foreground">
        Size
      </TableHead>
      <TableHead className="text-sm font-medium text-muted-foreground">
        Created
      </TableHead>
      <TableHead className="text-sm font-medium text-muted-foreground">
        Status
      </TableHead>
    </>
  );
}

function FileInfoCells({ file }: { file: RunFile }) {
  return (
    <>
      <TableCell className="py-2 font-mono text-sm">
        <span className="flex items-center gap-1.5">
          {file.filename}
          {DOWNLOADABLE_STATUSES.has(file.status) && (
            <a
              href={`/api/v1/files/${file.id}/download`}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              <Download className="size-4" />
            </a>
          )}
        </span>
      </TableCell>
      <TableCell className="py-2">
        <Badge variant="outline" className="capitalize">
          {file.category}
        </Badge>
      </TableCell>
      <TableCell className="py-2 text-sm text-muted-foreground">
        {formatBytes(file.sizeBytes)}
      </TableCell>
      <TableCell className="py-2 text-sm text-muted-foreground">
        {file.createdAt ? formatDateTime(file.createdAt) : "—"}
      </TableCell>
      <TableCell className="py-2">
        <StatusBadge file={file} />
      </TableCell>
    </>
  );
}

function ReprocessAction({
  file,
  isPending,
  onReprocess,
}: {
  file: RunFile;
  isPending: boolean;
  onReprocess: (id: number) => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RotateCw className="size-3" />
          )}
          Reprocess
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reprocess file?</AlertDialogTitle>
          <AlertDialogDescription>
            <strong className="font-mono">{file.filename}</strong> will be sent
            to the Lambda function for reprocessing. Any existing report data
            for this file will be cleared.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onReprocess(file.id)}>
            Reprocess
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function UploadDismissActions({
  file,
  isPending,
  onUpload,
  onDismiss,
}: {
  file: RunFile;
  isPending: boolean;
  onUpload: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  return (
    <>
      <WatcherGatedUploadButton
        variant="outline"
        size="sm"
        className="h-6 gap-1 px-2 text-xs"
        onClick={() => onUpload(file.id)}
        disabled={isPending}
      >
        <Upload className="size-3" />
        Upload
      </WatcherGatedUploadButton>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-muted-foreground"
            disabled={isPending}
          >
            <X className="size-3" />
            Dismiss
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss file?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong className="font-mono">{file.filename}</strong> will be
              soft-deleted. The watcher will skip it on future scans.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onDismiss(file.id)}>
              Dismiss
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function canReprocess(file: RunFile): boolean {
  return (
    file.deletedAt === null &&
    REPROCESSABLE_STATUSES.has(file.status) &&
    file.s3Key !== null
  );
}

// ---------------------------------------------------------------------------
// Read-only variant: no selection column, no upload/dismiss. Reprocessing is
// still allowed for completed/failed files so operators can recover report
// data without restoring the run.
// ---------------------------------------------------------------------------

export type ReadOnlyRunFilesTableProps = {
  files: RunFile[];
  isPending: boolean;
  onReprocess: (id: number) => void;
};

export function ReadOnlyRunFilesTable({
  files,
  isPending,
  onReprocess,
}: ReadOnlyRunFilesTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <FileColumnHeaders />
          <TableHead className="w-0" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => {
          const isDismissed = file.deletedAt !== null;
          return (
            <TableRow
              key={file.id}
              className={`group ${isDismissed ? "opacity-50" : ""}`}
            >
              <FileInfoCells file={file} />
              <TableCell className="py-2 pr-3">
                {canReprocess(file) && (
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <ReprocessAction
                      file={file}
                      isPending={isPending}
                      onReprocess={onReprocess}
                    />
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Editable variant: adds a selection column (for bulk upload/dismiss/reprocess
// /download flows) and per-row upload/dismiss/reprocess buttons. Selection
// state is read from FileSelectionProvider so the table doesn't carry a
// prop bag — consumers compose the table inside a provider and the bulk
// action bar reads from the same context.
// ---------------------------------------------------------------------------

export type EditableRunFilesTableProps = {
  files: RunFile[];
  isPending: boolean;
  onUpload: (id: number) => void;
  onDismiss: (id: number) => void;
  onReprocess: (id: number) => void;
};

export function EditableRunFilesTable({
  files,
  isPending,
  onUpload,
  onDismiss,
  onReprocess,
}: EditableRunFilesTableProps) {
  const { meta } = useFileSelection();

  // Pre-compute the FileRef for each visible row once so the select-all
  // header, the per-row checkbox, and the row-state styling all see the
  // same selectable set.
  const refsByFileId = new Map<number, ReturnType<typeof buildFileRef>>();
  const visibleSelectableRefs: NonNullable<ReturnType<typeof buildFileRef>>[] =
    [];
  for (const file of files) {
    const ref = buildFileRef(file);
    refsByFileId.set(file.id, ref);
    if (ref) visibleSelectableRefs.push(ref);
  }

  const showSelectionColumn = visibleSelectableRefs.length > 0;
  const hasBulkSelection = meta.count > 0;

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {showSelectionColumn && (
            <TableHead className="w-10 pr-0 pl-3">
              <FileSelectAllCheckbox refs={visibleSelectableRefs} />
            </TableHead>
          )}
          <FileColumnHeaders />
          <TableHead className="w-0" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => {
          const isDismissed = file.deletedAt !== null;
          const ref = refsByFileId.get(file.id) ?? null;
          const isSelected = ref ? meta.isSelected(ref.id) : false;
          const canDoUploadDismiss = !isDismissed && file.status === "detected";
          const canDoReprocess = canReprocess(file);

          // Reveal classes: hide per-row actions while a bulk selection is
          // active (the bar is the single entry point) but keep the JSX
          // mounted so the actions column doesn't collapse and shift
          // sibling columns. We stay in the opacity-0 baseline in both
          // states — the only thing that changes is whether the hover/
          // focus reveal rules are in the class list — so the browser
          // never has to interpolate between an in-flight hover fade-in
          // and a different hide mechanism, which is what was producing
          // a brief "all actions visible" flash on the click frame.
          const revealClass = hasBulkSelection
            ? "opacity-0 pointer-events-none"
            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity";

          return (
            <TableRow
              key={file.id}
              data-state={isSelected ? "selected" : undefined}
              className={`group ${isDismissed ? "opacity-50" : ""}`}
            >
              {showSelectionColumn && (
                <TableCell className="py-2 pr-0 pl-3">
                  {ref ? (
                    <FileSelectCheckbox fileRef={ref} />
                  ) : (
                    <div className="size-4" />
                  )}
                </TableCell>
              )}
              <FileInfoCells file={file} />
              <TableCell className="py-2 pr-3">
                {canDoUploadDismiss ? (
                  <div className={`flex items-center gap-1 ${revealClass}`}>
                    <UploadDismissActions
                      file={file}
                      isPending={isPending}
                      onUpload={onUpload}
                      onDismiss={onDismiss}
                    />
                  </div>
                ) : canDoReprocess ? (
                  <div className={`flex items-center gap-1 ${revealClass}`}>
                    <ReprocessAction
                      file={file}
                      isPending={isPending}
                      onReprocess={onReprocess}
                    />
                  </div>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
