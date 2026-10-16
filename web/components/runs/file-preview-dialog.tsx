"use client";

import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { ColonyDataTableView } from "@/components/runs/colony-data-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trackClientEvent } from "@/lib/analytics/track-client";
import { type FilePreview, loadFilePreview } from "@/lib/runs/file-preview";
import type { FilePreviewKind } from "@/lib/runs/run-file-types";

export interface PreviewableFile {
  category: string;
  filename: string;
  id: number;
  kind: FilePreviewKind;
}

type LoadState =
  | { fileId: number; status: "ready"; preview: FilePreview }
  | { fileId: number; status: "error"; message: string };

export function FilePreviewDialog({
  files,
  onOpenChange,
  onSelect,
  openFileId,
}: {
  files: PreviewableFile[];
  onOpenChange: (open: boolean) => void;
  onSelect: (fileId: number) => void;
  openFileId: number | null;
}) {
  const index = files.findIndex((f) => f.id === openFileId);
  const current = index === -1 ? null : files[index];
  const currentId = current?.id ?? null;
  const currentKind = current?.kind ?? null;
  const currentCategory = current?.category ?? null;

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
    if (currentId === null || currentKind === null) {
      cacheRef.current.clear();
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
      <DialogContent className="sm:max-w-4xl" showCloseButton={false}>
        <DialogHeader className="min-w-0">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <DialogTitle className="min-w-0 truncate font-mono text-base">
              {current?.filename}
            </DialogTitle>
            <div className="flex shrink-0 items-center gap-1">
              {current && (
                <Button asChild variant="outline">
                  <a
                    download={current.filename}
                    href={`/api/v1/files/${current.id}/download`}
                  >
                    <Download />
                    Download
                  </a>
                </Button>
              )}
              <Button
                aria-label="Previous file"
                disabled={previous === null}
                onClick={() => previous && onSelect(previous.id)}
                size="icon"
                variant="outline"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                aria-label="Next file"
                disabled={next === null}
                onClick={() => next && onSelect(next.id)}
                size="icon"
                variant="outline"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <DialogDescription className="sr-only">
            Preview of {current?.filename}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-2">
          {state === null && (
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
      </DialogContent>
    </Dialog>
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
