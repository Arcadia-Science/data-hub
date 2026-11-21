"use client";

import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  FileQuestion,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { useRunDownloadClaimPrompt } from "@/components/runs/claim-prompt/run-claim-target";
import { ColonyDataTableView } from "@/components/runs/colony-data-table";
import { PdfFrame } from "@/components/runs/pdf-carousel-report";
import { ReportImage } from "@/components/runs/report-image";
import { RunVideoPlayer } from "@/components/runs/run-video-player";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import { useReturnFocus } from "@/hooks/use-return-focus";
import { trackClientEvent } from "@/lib/analytics/track-client";
import { formatDateTime } from "@/lib/date";
import { canDeleteFile } from "@/lib/runs/deletable-files";
import { deletedBanner } from "@/lib/runs/deleted-file-note";
import {
  type LinkedFileRelation,
  linkedFileLabel,
  linkedFilesOf,
} from "@/lib/runs/file-links";
import { type FilePreview, loadFilePreview } from "@/lib/runs/file-preview";
import type { PreviewFile } from "@/lib/runs/preview-files";
import { fileFormatName } from "@/lib/runs/run-file-types";
import { cn, formatBytes } from "@/lib/utils";
import type { FileTarget } from "./file-action-dialog";
import { DELETED_BADGE_CLASS, DELETED_TEXT_CLASS } from "./file-status-config";
import { FileStatusIndicator } from "./file-status-indicator";
import { useFileDeleteRestore } from "./use-file-delete-restore";

type LoadState =
  | { fileId: number; status: "ready"; preview: FilePreview }
  | { fileId: number; status: "error"; message: string };

interface FilePreviewDialogProps {
  // The files on the page, in table order. Previous and next step through them.
  files: PreviewFile[];
  instrumentId: string;
  // A deleted run is read-only: the window offers no Delete or Restore.
  isRunDeleted: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (fileId: number) => void;
  openFileId: number | null;
  // Files off the page that the open file links to. Each opens here too.
  relatedFiles: PreviewFile[];
  runId: string;
}

export function FilePreviewDialog({
  files,
  instrumentId,
  isRunDeleted,
  onOpenChange,
  onSelect,
  openFileId,
  relatedFiles,
  runId,
}: FilePreviewDialogProps) {
  const index = files.findIndex((f) => f.id === openFileId);
  const current =
    index === -1
      ? (relatedFiles.find((f) => f.id === openFileId) ?? null)
      : files[index];
  const currentId = current?.id ?? null;
  const currentKind = current?.kind ?? null;
  const currentMedia = current?.media ?? null;
  const currentCategory = current?.category ?? null;
  // Shows after the dialog closes; the dialog covers it until then.
  const promptClaim = useRunDownloadClaimPrompt();
  const timeZone = useViewerTimeZone();

  // Delete and Restore, with the dialogs they open. These render inside the
  // window's content, so the window stays open behind them.
  const [isActionPending, startAction] = useTransition();
  const { askDelete, askRestore, dialogs } = useFileDeleteRestore({
    instrumentId,
    runId,
    startAction,
  });

  // The files this one links to, in both directions, deleted ones included.
  const linked = useMemo(() => {
    if (current === null) {
      return [];
    }
    const everyFile = [...files, ...relatedFiles];
    const byId = new Map(everyFile.map((file) => [file.id, file]));
    return linkedFilesOf(
      current.row,
      everyFile.map((file) => file.row)
    ).flatMap(({ file, relation }) => {
      const entry = byId.get(file.id);
      return entry ? [{ entry, relation }] : [];
    });
  }, [current, files, relatedFiles]);

  // Where focus goes after a linked file opens in place of this one, and after
  // a restore takes the banner and its button away.
  const titleRef = useRef<HTMLHeadingElement>(null);

  // The window opens from state, so Radix has no trigger to give focus back
  // to. It goes back to the row of the file shown last, which Previous and
  // Next may have moved off the row that opened it, or to that row when the
  // last file shown isn't in the table.
  const lastShownId = useRef<number | null>(null);
  useEffect(() => {
    if (currentId !== null) {
      lastShownId.current = currentId;
    }
  }, [currentId]);
  const returnFocus = useReturnFocus((opener) => {
    const id = lastShownId.current;
    return id === null
      ? null
      : (opener
          .closest("table")
          ?.querySelector<HTMLElement>(`[data-file-id="${id}"]`) ?? null);
  });

  const [result, setResult] = useState<LoadState | null>(null);
  const [page, setPage] = useState(0);
  // Bumped on retry to re-run the load effect for the same file.
  const [retryNonce, setRetryNonce] = useState(0);
  // Holds up to 1 MB per file, so it is emptied when the dialog closes.
  const cacheRef = useRef<Map<number, Promise<FilePreview>>>(new Map());
  const requestId = useRef(0);

  useEffect(() => {
    // Bumped on every run, including close, so a response that lands after
    // the file changed or the dialog closed is ignored.
    const id = requestId.current + 1;
    requestId.current = id;
    if (currentId === null) {
      cacheRef.current.clear();
      return;
    }
    // A file the window can't show has nothing to load. The cache stays, so
    // stepping past it and back doesn't fetch the neighbors again.
    if (currentKind === null) {
      return;
    }
    void retryNonce;
    setPage(0);

    let pending = cacheRef.current.get(currentId);
    let owned: { controller: AbortController; settled: boolean } | null = null;
    if (!pending) {
      const request = { controller: new AbortController(), settled: false };
      owned = request;
      const loading = loadFilePreview(
        currentId,
        currentKind,
        request.controller.signal
      );
      pending = loading;
      cacheRef.current.set(currentId, loading);
      loading.then(
        () => {
          request.settled = true;
        },
        () => {
          request.settled = true;
          if (cacheRef.current.get(currentId) === loading) {
            cacheRef.current.delete(currentId);
          }
        }
      );
    }
    pending
      .then((preview) => {
        if (requestId.current === id) {
          setResult({ fileId: currentId, status: "ready", preview });
          trackClientEvent("file_previewed", {
            category: currentCategory ?? "",
            kind: currentKind,
          });
        }
      })
      .catch((err: unknown) => {
        if (requestId.current === id) {
          setResult({
            fileId: currentId,
            message:
              err instanceof Error ? err.message : "Failed to load the file",
            status: "error",
          });
        }
      });

    return () => {
      // Only an unfinished request started by this run is cancelled. Its cache
      // entry goes too, so a re-run (Strict Mode, or reopening) fetches again.
      if (owned && !owned.settled) {
        if (cacheRef.current.get(currentId) === pending) {
          cacheRef.current.delete(currentId);
        }
        owned.controller.abort();
      }
    };
  }, [currentId, currentKind, currentCategory, retryNonce]);

  // Pictures, videos, and PDFs load themselves, so a view is counted when one
  // opens.
  useEffect(() => {
    if (currentId !== null && currentMedia !== null) {
      trackClientEvent("file_previewed", {
        category: currentCategory ?? "",
        kind: currentMedia,
      });
    }
  }, [currentId, currentMedia, currentCategory]);

  function handleRetry() {
    if (currentId !== null) {
      cacheRef.current.delete(currentId);
    }
    setResult(null);
    setRetryNonce((n) => n + 1);
  }

  const state = result && result.fileId === currentId ? result : null;
  const previous = index > 0 ? files[index - 1] : null;
  const next =
    index !== -1 && index < files.length - 1 ? files[index + 1] : null;

  const row = current?.row ?? null;
  const deleted = row !== null && row.deletedAt !== null;
  const target: FileTarget | null = row
    ? {
        id: row.id,
        filename: row.filename,
        relativePath: row.relativePath,
        sizeBytes: row.sizeBytes,
      }
    : null;
  // The preview image of this file, for a video's still and for the message of
  // a format the window can't show.
  const previewImage =
    linked.find(
      (link) => link.relation === "preview_image" && link.entry.downloadable
    )?.entry ?? null;

  // A linked file opens in this window in place of the current file. The
  // button that was clicked belongs to the old file's details, so focus goes to
  // the title. A file that is off the page has nothing for Previous and Next to
  // step from, so both stay disabled until a file on the page opens again.
  function openLinked(fileId: number) {
    onSelect(fileId);
    requestAnimationFrame(() => titleRef.current?.focus());
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setResult(null);
        }
        onOpenChange(open);
      }}
      open={current !== null}
    >
      <DialogContent
        className="sm:max-w-4xl"
        showCloseButton={false}
        {...returnFocus}
        onOpenAutoFocus={(event) => {
          returnFocus.onOpenAutoFocus();
          // Focus starts on the file's name. Radix would pick the first
          // button, which is Delete for most files, so an Enter pressed as
          // the window opened would start a delete.
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogHeader className="min-w-0">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <DialogTitle
              className={cn(
                "min-w-0 truncate font-mono text-base outline-none",
                deleted && "text-muted-foreground"
              )}
              ref={titleRef}
              tabIndex={-1}
            >
              {current?.filename}
            </DialogTitle>
            <div className="flex shrink-0 items-center gap-1.5">
              {current?.downloadable && (
                <Button asChild size="sm" variant="outline">
                  <a
                    download={current.filename}
                    href={`/api/v1/files/${current.id}/download`}
                    onClick={promptClaim}
                  >
                    <Download />
                    Download
                  </a>
                </Button>
              )}
              {row !== null &&
                target !== null &&
                !isRunDeleted &&
                canDeleteFile(row) && (
                  // Waits with `aria-disabled`, not `disabled`, so focus can
                  // come back to it when its dialog closes.
                  <Button
                    aria-disabled={isActionPending}
                    className="border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive"
                    onClick={() => {
                      if (!isActionPending) {
                        askDelete([target], {
                          onConfirmed: () => onOpenChange(false),
                        });
                      }
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Trash2 />
                    Delete
                  </Button>
                )}
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
              <Button
                aria-label="Previous file"
                disabled={previous === null}
                onClick={() => previous && onSelect(previous.id)}
                size="icon-sm"
                variant="outline"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                aria-label="Next file"
                disabled={next === null}
                onClick={() => next && onSelect(next.id)}
                size="icon-sm"
                variant="outline"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <DialogDescription className="sr-only">
            Details and preview of {current?.filename}
          </DialogDescription>
        </DialogHeader>

        {row !== null && target !== null && row.deletedAt !== null && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800 text-sm dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
            role="status"
          >
            <Trash2 aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 basis-80">
              {deletedBanner(
                { deleter: row.deleter, deletedAt: row.deletedAt },
                timeZone
              )}
            </span>
            {!isRunDeleted && (
              <Button
                aria-disabled={isActionPending}
                className="bg-background text-foreground"
                onClick={() => {
                  // Once the file is back, the banner and this button go, so
                  // focus moves to the title and stays in the window.
                  if (!isActionPending) {
                    askRestore([target], {
                      onSettled: () => titleRef.current?.focus(),
                    });
                  }
                }}
                size="sm"
                variant="outline"
              >
                <Undo2 />
                Restore
              </Button>
            )}
          </div>
        )}

        {row !== null && (
          <>
            {/* Sits closer to the title than the window's usual gap, unless the
                deleted banner comes between them. */}
            <div
              className={cn(
                "flex flex-wrap items-center gap-3 text-muted-foreground text-sm",
                (target === null || row.deletedAt === null) && "-mt-3"
              )}
            >
              <Badge
                className={cn(
                  "capitalize",
                  deleted
                    ? DELETED_BADGE_CLASS
                    : row.category === "raw"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                      : "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                )}
              >
                {row.category}
              </Badge>
              <span
                className={cn("tabular-nums", deleted && DELETED_TEXT_CLASS)}
              >
                {formatBytes(row.sizeBytes)}
              </span>
              <FileStatusIndicator file={row} />
            </div>
            <FileDetails
              linked={linked}
              onOpenLinked={openLinked}
              row={row}
              timeZone={timeZone}
            />
          </>
        )}

        <div className="flex min-w-0 flex-col gap-2">
          {current && current.kind === null && current.media === null && (
            <NoPreview
              file={current}
              onOpenPreviewImage={
                previewImage ? () => openLinked(previewImage.id) : null
              }
              previewImageName={previewImage?.filename ?? null}
            />
          )}
          {current?.media === "image" && (
            <ReportImage fileId={current.id} filename={current.filename} />
          )}
          {current?.media === "video" && (
            <RunVideoPlayer
              fileId={current.id}
              filename={current.filename}
              key={current.id}
              posterFileId={previewImage?.id}
            />
          )}
          {current?.media === "pdf" && (
            <PdfFrame
              fileId={current.id}
              filename={current.filename}
              key={current.id}
            />
          )}
          {current && current.kind !== null && state === null && (
            <LoadingSkeleton className="h-72 w-full" label="Loading preview…" />
          )}
          {state?.status === "error" && (
            <div
              className="flex h-72 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/20 p-6 text-center"
              role="alert"
            >
              <AlertTriangle
                aria-hidden
                className="size-6 text-muted-foreground"
              />
              <p className="text-muted-foreground text-sm">{state.message}</p>
              <Button onClick={handleRetry} size="sm" variant="outline">
                Retry
              </Button>
            </div>
          )}
          {state?.status === "ready" && (
            <>
              {state.preview.truncated && (
                <p className="text-muted-foreground text-xs">
                  Showing the first part of this file.
                </p>
              )}
              <PreviewBody
                onPageChange={setPage}
                page={page}
                preview={state.preview}
              />
            </>
          )}
        </div>
        {dialogs}
      </DialogContent>
    </Dialog>
  );
}

// The details under the file's name: where it is, when it was made, uploaded,
// and processed, and the files it links to. A date the file has no value for is
// left out.
function FileDetails({
  linked,
  onOpenLinked,
  row,
  timeZone,
}: {
  linked: { entry: PreviewFile; relation: LinkedFileRelation }[];
  onOpenLinked: (fileId: number) => void;
  row: PreviewFile["row"];
  timeZone: string;
}) {
  const dates: [string, Date | null][] = [
    ["Created", row.fileCreatedAt ?? row.createdAt],
    ["Uploaded", row.uploadedAt],
    ["Processed", row.processedAt],
  ];
  return (
    <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
      <dt className="text-muted-foreground">Path</dt>
      <dd className="break-all font-mono text-[13px]">
        {row.relativePath ?? row.filename}
      </dd>
      {dates.map(([label, date]) =>
        date === null ? null : (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{formatDateTime(date, timeZone)}</dd>
          </Fragment>
        )
      )}
      {linked.length > 0 && (
        <>
          <dt className="text-muted-foreground">Linked files</dt>
          <dd>
            <ul className="flex flex-col gap-1.5">
              {linked.map(({ entry, relation }) => (
                <LinkedFileItem
                  entry={entry}
                  key={entry.id}
                  onOpen={onOpenLinked}
                  relation={relation}
                />
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}

function LinkedFileItem({
  entry,
  onOpen,
  relation,
}: {
  entry: PreviewFile;
  onOpen: (fileId: number) => void;
  relation: LinkedFileRelation;
}) {
  const deleted = entry.row.deletedAt !== null;
  const label = linkedFileLabel(relation, deleted);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {label.lead && (
        <span className="text-muted-foreground">{label.lead}</span>
      )}
      <button
        className={cn(
          "rounded-sm text-left font-mono text-[13px] underline decoration-border underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring",
          deleted && "text-muted-foreground"
        )}
        onClick={() => onOpen(entry.id)}
        type="button"
      >
        {entry.filename}
      </button>
      {label.trail !== "" && (
        <span className="text-muted-foreground">{label.trail}</span>
      )}
    </li>
  );
}

// What a file shows when the window can't display its contents, so a click on
// any row still opens something. A file whose preview image is known points to
// it.
function NoPreview({
  file,
  onOpenPreviewImage,
  previewImageName,
}: {
  file: PreviewFile;
  onOpenPreviewImage: (() => void) | null;
  previewImageName: string | null;
}) {
  const format = fileFormatName(file.filename);
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm">
      <FileQuestion
        aria-hidden="true"
        className="size-6 text-muted-foreground"
      />
      {file.downloadable ? (
        <>
          <p className="font-medium">
            {format
              ? `${format} files can’t be previewed here`
              : "This file can’t be previewed here"}
          </p>
          <p className="text-muted-foreground">
            {onOpenPreviewImage && previewImageName ? (
              <>
                Open the preview image{" "}
                <button
                  className="rounded-sm font-mono text-[13px] text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={onOpenPreviewImage}
                  type="button"
                >
                  {previewImageName}
                </button>
                , or download the file.
              </>
            ) : (
              "Use Download to save it."
            )}
          </p>
        </>
      ) : (
        <>
          <p className="font-medium">This file isn’t in Data Hub yet.</p>
          <p className="text-muted-foreground">
            Once it uploads, you can download it here.
          </p>
        </>
      )}
    </div>
  );
}

function PreviewBody({
  onPageChange,
  page,
  preview,
}: {
  onPageChange: (next: number) => void;
  page: number;
  preview: FilePreview;
}) {
  const { content } = preview;
  if (content.kind === "table" && content.rows.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md border border-dashed bg-muted/20 text-muted-foreground text-sm">
        This file has no rows.
      </div>
    );
  }
  if (content.kind === "table") {
    return (
      <div className="max-h-[60vh] overflow-auto">
        <ColonyDataTableView
          onPageChange={onPageChange}
          page={page}
          rows={content.rows}
        />
      </div>
    );
  }
  if (content.text === "") {
    return (
      <div className="flex h-24 items-center justify-center rounded-md border border-dashed bg-muted/20 text-muted-foreground text-sm">
        This file is empty.
      </div>
    );
  }
  return (
    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3 font-mono text-xs">
      {content.text}
    </pre>
  );
}
