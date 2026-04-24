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
import { Checkbox } from "@/components/ui/checkbox";
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

export type RunFilesTableSelection = {
  selectedIds: Set<number>;
  visibleSelectableIds: Set<number>;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  hasBulkSelection: boolean;
  onToggleFile: (id: number) => void;
  onToggleAll: () => void;
};

export type RunFilesTableProps = {
  files: RunFile[];
  isDeleted: boolean;
  isPending: boolean;
  // When false, per-row "Upload" actions are disabled so users can't queue
  // a transition to `upload_requested` that no agent would pick up.
  isWatcherOnline: boolean;
  selection: RunFilesTableSelection;
  onUpload: (id: number) => void;
  onDismiss: (id: number) => void;
  onReprocess: (id: number) => void;
};

const WATCHER_OFFLINE_UPLOAD_TOOLTIP =
  "Watcher is offline. Bring the watcher online before requesting uploads — otherwise nothing will transfer this file to S3.";

export function RunFilesTable({
  files,
  isDeleted,
  isPending,
  isWatcherOnline,
  selection,
  onUpload,
  onDismiss,
  onReprocess,
}: RunFilesTableProps) {
  const {
    selectedIds,
    visibleSelectableIds,
    allVisibleSelected,
    someVisibleSelected,
    hasBulkSelection,
    onToggleFile,
    onToggleAll,
  } = selection;

  const showSelectionColumn = !isDeleted && visibleSelectableIds.size > 0;

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {showSelectionColumn && (
            <TableHead className="w-10 pr-0 pl-3">
              <Checkbox
                checked={
                  allVisibleSelected
                    ? true
                    : someVisibleSelected
                      ? "indeterminate"
                      : false
                }
                onCheckedChange={onToggleAll}
              />
            </TableHead>
          )}
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
          <TableHead className="w-0" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => {
          const isDismissed = file.deletedAt !== null;
          const isSelectable =
            !isDeleted && file.status === "detected" && !isDismissed;
          const isSelected = selectedIds.has(file.id);
          const showRowActions =
            !isDeleted &&
            !isDismissed &&
            file.status === "detected" &&
            !hasBulkSelection;

          return (
            <TableRow
              key={file.id}
              data-state={isSelected ? "selected" : undefined}
              className={`group ${isDismissed ? "opacity-50" : ""}`}
            >
              {showSelectionColumn && (
                <TableCell className="py-2 pr-0 pl-3">
                  {isSelectable ? (
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => onToggleFile(file.id)}
                    />
                  ) : (
                    <div className="size-4" />
                  )}
                </TableCell>
              )}
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
              <TableCell className="py-2 pr-3">
                {showRowActions ? (
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    {isWatcherOnline ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 gap-1 px-2 text-xs"
                        onClick={() => onUpload(file.id)}
                        disabled={isPending}
                      >
                        <Upload className="size-3" />
                        Upload
                      </Button>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {/* Wrapping span keeps the tooltip reachable while
                              the underlying button is disabled. */}
                          <span tabIndex={0}>
                            <Button
                              variant="outline"
                              size="sm"
                              className="pointer-events-none h-6 gap-1 px-2 text-xs"
                              disabled
                            >
                              <Upload className="size-3" />
                              Upload
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          {WATCHER_OFFLINE_UPLOAD_TOOLTIP}
                        </TooltipContent>
                      </Tooltip>
                    )}
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
                            <strong className="font-mono">
                              {file.filename}
                            </strong>{" "}
                            will be soft-deleted. The watcher will skip it on
                            future scans.
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
                  </div>
                ) : (
                  !isDismissed &&
                  REPROCESSABLE_STATUSES.has(file.status) &&
                  file.s3Key !== null && (
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
                              <strong className="font-mono">
                                {file.filename}
                              </strong>{" "}
                              will be sent to the Lambda function for
                              reprocessing. Any existing report data for this
                              file will be cleared.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => onReprocess(file.id)}
                            >
                              Reprocess
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
