"use client";

import { Download, Loader2, RotateCw, Upload, X } from "lucide-react";
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
import type { RunFile } from "@/lib/api/instrument-runs";
import { formatDateTime } from "@/lib/date";
import { isProcessableInstrumentType } from "@/lib/instruments/processable-types";
import { REPROCESSABLE_STATUSES } from "@/lib/runs/reprocessable-statuses";
import { cn, formatBytes } from "@/lib/utils";
import {
  FileSelectAllCheckbox,
  FileSelectCheckbox,
} from "./file-select-checkbox";
import { buildFileRef, useFileSelection } from "./file-selection-provider";
import { FileStatusColumnHeader } from "./file-status-column-header";
import { FileStatusIndicator } from "./file-status-indicator";
import { WatcherGatedUploadButton } from "./watcher-gated-upload-button";

const DOWNLOADABLE_STATUSES = new Set([
  "uploaded",
  "processing",
  "completed",
  "failed",
]);

const REPROCESSABLE_STATUS_SET = new Set<string>(REPROCESSABLE_STATUSES);

const CATEGORY_BADGE_CLASSES: Record<string, string> = {
  raw: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  processed:
    "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
};

// ---------------------------------------------------------------------------
// Shared table pieces used by both the editable and read-only variants.
// ---------------------------------------------------------------------------

function FileColumnHeaders() {
  return (
    <>
      <TableHead>File name</TableHead>
      <TableHead>Type</TableHead>
      <TableHead>Size</TableHead>
      <TableHead>Created</TableHead>
      <TableHead>
        <FileStatusColumnHeader />
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
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              href={`/api/v1/files/${file.id}/download`}
            >
              <Download className="size-4" />
            </a>
          )}
        </span>
      </TableCell>
      <TableCell className="py-2">
        <Badge
          className={cn(
            "capitalize",
            CATEGORY_BADGE_CLASSES[file.category] ??
              "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300"
          )}
        >
          {file.category}
        </Badge>
      </TableCell>
      <TableCell className="py-2 text-muted-foreground text-sm">
        {formatBytes(file.sizeBytes)}
      </TableCell>
      <TableCell className="py-2 text-muted-foreground text-sm">
        {file.fileCreatedAt
          ? formatDateTime(file.fileCreatedAt)
          : file.createdAt
            ? formatDateTime(file.createdAt)
            : "—"}
      </TableCell>
      <TableCell className="py-2 align-middle">
        <FileStatusIndicator file={file} />
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
          className="h-6 gap-1 px-2 text-xs"
          disabled={isPending}
          size="sm"
          variant="outline"
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
        className="h-6 gap-1 px-2 text-xs"
        disabled={isPending}
        onClick={() => onUpload(file.id)}
        size="sm"
        variant="outline"
      >
        <Upload className="size-3" />
        Upload
      </WatcherGatedUploadButton>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            className="h-6 gap-1 px-2 text-muted-foreground text-xs"
            disabled={isPending}
            size="sm"
            variant="ghost"
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

function canReprocess(file: RunFile, instrumentType: string): boolean {
  return (
    file.deletedAt === null &&
    isProcessableInstrumentType(instrumentType) &&
    REPROCESSABLE_STATUS_SET.has(file.status) &&
    file.s3Key !== null
  );
}

// ---------------------------------------------------------------------------
// Read-only variant: no selection column, no upload/dismiss. Reprocessing is
// still allowed for uploaded/completed/failed files so operators can recover
// report data or kick stuck uploads without restoring the run.
// ---------------------------------------------------------------------------

export interface ReadOnlyRunFilesTableProps {
  files: RunFile[];
  instrumentType: string;
  isPending: boolean;
  onReprocess: (id: number) => void;
}

export function ReadOnlyRunFilesTable({
  files,
  instrumentType,
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
              className={`group ${isDismissed ? "opacity-50" : ""}`}
              key={file.id}
            >
              <FileInfoCells file={file} />
              <TableCell className="py-2 pr-3">
                {canReprocess(file, instrumentType) ? (
                  <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
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

// ---------------------------------------------------------------------------
// Editable variant: adds a selection column (for bulk upload/dismiss/reprocess
// /download flows) and per-row upload/dismiss/reprocess buttons. Selection
// state is read from FileSelectionProvider so the table doesn't carry a
// prop bag — consumers compose the table inside a provider and the bulk
// action bar reads from the same context.
// ---------------------------------------------------------------------------

export interface EditableRunFilesTableProps {
  files: RunFile[];
  instrumentType: string;
  isPending: boolean;
  onDismiss: (id: number) => void;
  onReprocess: (id: number) => void;
  onUpload: (id: number) => void;
}

export function EditableRunFilesTable({
  files,
  instrumentType,
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
    const ref = buildFileRef(file, instrumentType);
    refsByFileId.set(file.id, ref);
    if (ref) {
      visibleSelectableRefs.push(ref);
    }
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
          const canDoReprocess = canReprocess(file, instrumentType);

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
              className={`group ${isDismissed ? "opacity-50" : ""}`}
              data-state={isSelected ? "selected" : undefined}
              key={file.id}
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
                      onDismiss={onDismiss}
                      onUpload={onUpload}
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
