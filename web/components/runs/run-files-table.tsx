"use client";

import {
  type ComponentProps,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { LoadErrorBoundary } from "@/components/load-error-boundary";
import { TruncatedTooltip } from "@/components/truncated-tooltip";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import type { RunFileRow } from "@/lib/api/instrument-runs";
import { formatDateTime } from "@/lib/date";
import type { InstrumentType } from "@/lib/db/schema";
import { preloader } from "@/lib/preload";
import { previewFilesOf } from "@/lib/runs/preview-files";
import { cn, formatBytes } from "@/lib/utils";
import { FilePreviewLoading } from "./file-preview-loading";
import {
  FileSelectAllCheckbox,
  FileSelectCheckbox,
} from "./file-select-checkbox";
import { buildFileRef, useFileSelection } from "./file-selection-provider";
import { FileStatusIndicator } from "./file-status-indicator";
import { FileStatusLegendButton } from "./file-status-legend";
import { FilesSortHeader } from "./files-sort-header";

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
      <FilesSortHeader field="name" label="File name" />
      <TableHead>Type</TableHead>
      <FilesSortHeader align="end" field="size" label="Size" />
      <FilesSortHeader align="end" field="date" label="Created" />
      <FilesSortHeader
        field="status"
        label="Status"
        trailing={<FileStatusLegendButton />}
      />
    </>
  );
}

// The dialog pulls in the CSV parser and the colony table. Most visits never
// open a preview, so that code loads on the first open instead of with the
// page, or earlier when the pointer or focus reaches a file name.
const loadFilePreviewDialog = () =>
  import("./file-preview-dialog").then((m) => ({
    default: m.FilePreviewDialog,
  }));

const FilePreviewDialog = lazy(loadFilePreviewDialog);
const preloadFilePreviewDialog = preloader(loadFilePreviewDialog);

// Shared by both table variants. Every file opens, and previous and next step
// through the files on the current page, in table order.
function useFilePreview(files: RunFileRow[]) {
  const [openFileId, setOpenFileId] = useState<number | null>(null);
  // Stays mounted after the first open so closing still plays its animation.
  const [hasOpened, setHasOpened] = useState(false);
  const previewFiles = useMemo(() => previewFilesOf(files), [files]);
  const isOpenFileListed = previewFiles.some((f) => f.id === openFileId);

  // Closes the dialog when its file leaves the page, e.g. it was dismissed in
  // another tab and the auto-refresh dropped it.
  useEffect(() => {
    if (openFileId !== null && !isOpenFileListed) {
      setOpenFileId(null);
    }
  }, [openFileId, isOpenFileListed]);

  const dialog = hasOpened ? (
    <LoadErrorBoundary
      fallback={null}
      onError={() => {
        setOpenFileId(null);
        toast.error("Couldn’t load the preview. Reload the page to try again.");
      }}
    >
      <Suspense
        fallback={
          openFileId === null ? null : (
            <FilePreviewLoading onClose={() => setOpenFileId(null)} />
          )
        }
      >
        <FilePreviewDialog
          files={previewFiles}
          onOpenChange={(open) => {
            if (!open) {
              setOpenFileId(null);
            }
          }}
          onSelect={setOpenFileId}
          openFileId={openFileId}
        />
      </Suspense>
    </LoadErrorBoundary>
  ) : null;

  function openPreview(fileId: number) {
    setHasOpened(true);
    setOpenFileId(fileId);
  }

  return { dialog, openPreview };
}

// A click anywhere on the row opens the file, except in the cell that holds the
// selection checkbox: a click there changes the selection and nothing else.
// That cell marks itself with `data-row-control` to opt out.
function FileTableRow({
  className,
  file,
  onPreview,
  ...props
}: ComponentProps<typeof TableRow> & {
  file: RunFileRow;
  onPreview: (fileId: number) => void;
}) {
  return (
    <TableRow
      {...props}
      className={cn("cursor-pointer", className)}
      onClick={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("[data-row-control]")) {
          return;
        }
        onPreview(file.id);
      }}
      onMouseEnter={preloadFilePreviewDialog}
    />
  );
}

function FileInfoCells({ file }: { file: RunFileRow }) {
  const timeZone = useViewerTimeZone();
  return (
    <>
      {/* Long instrument filenames cut off with an ellipsis instead of pushing
          the status column off screen. The tooltip shows the rest. The button
          is how a keyboard reaches the file; its click bubbles to the row,
          which opens it. */}
      <TableCell className="max-w-sm py-2 font-mono text-sm">
        <TruncatedTooltip text={file.filename}>
          <button
            className="block max-w-full cursor-pointer truncate text-left"
            onFocus={preloadFilePreviewDialog}
            type="button"
          >
            {file.filename}
          </button>
        </TruncatedTooltip>
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
      <TableCell className="py-2 text-right text-muted-foreground text-sm tabular-nums">
        {formatBytes(file.sizeBytes)}
      </TableCell>
      <TableCell className="py-2 text-right text-muted-foreground text-sm tabular-nums">
        {file.fileCreatedAt
          ? formatDateTime(file.fileCreatedAt, timeZone)
          : file.createdAt
            ? formatDateTime(file.createdAt, timeZone)
            : "—"}
      </TableCell>
      <TableCell className="py-2 align-middle">
        <FileStatusIndicator file={file} />
      </TableCell>
    </>
  );
}

// ---------------------------------------------------------------------------
// Read-only variant, for a deleted run: no selection column, so nothing on the
// page changes the run's files. Rows still open the file window.
// ---------------------------------------------------------------------------

export function ReadOnlyRunFilesTable({ files }: { files: RunFileRow[] }) {
  const { dialog, openPreview } = useFilePreview(files);
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <FileColumnHeaders />
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => (
            <FileTableRow
              className={file.deletedAt === null ? undefined : "opacity-50"}
              file={file}
              key={file.id}
              onPreview={openPreview}
            >
              <FileInfoCells file={file} />
            </FileTableRow>
          ))}
        </TableBody>
      </Table>
      {dialog}
    </>
  );
}

// ---------------------------------------------------------------------------
// Editable variant: adds a selection column. Rows have no buttons of their own;
// every action goes through the bar that floats at the bottom of the window
// while files are selected. Selection state is read from FileSelectionProvider
// so the table doesn't carry a prop bag — consumers compose the table inside a
// provider and the bulk action bar reads from the same context.
// ---------------------------------------------------------------------------

export function EditableRunFilesTable({
  files,
  instrumentType,
}: {
  files: RunFileRow[];
  instrumentType: InstrumentType;
}) {
  const { meta } = useFileSelection();
  const { dialog, openPreview } = useFilePreview(files);

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

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {showSelectionColumn && (
              <TableHead className="w-10 pr-0 pl-3">
                <FileSelectAllCheckbox refs={visibleSelectableRefs} />
              </TableHead>
            )}
            <FileColumnHeaders />
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => {
            const ref = refsByFileId.get(file.id) ?? null;
            const isSelected = ref ? meta.isSelected(ref.id) : false;
            return (
              <FileTableRow
                className={file.deletedAt === null ? undefined : "opacity-50"}
                data-state={isSelected ? "selected" : undefined}
                file={file}
                key={file.id}
                onPreview={openPreview}
              >
                {showSelectionColumn && (
                  // Only a cell that holds a checkbox keeps the click to
                  // itself. An empty one opens the file like the rest of the
                  // row.
                  <TableCell
                    className="py-2 pr-0 pl-3"
                    data-row-control={ref ? true : undefined}
                  >
                    {ref ? (
                      <FileSelectCheckbox fileRef={ref} />
                    ) : (
                      <div className="size-4" />
                    )}
                  </TableCell>
                )}
                <FileInfoCells file={file} />
              </FileTableRow>
            );
          })}
        </TableBody>
      </Table>
      {dialog}
    </>
  );
}
