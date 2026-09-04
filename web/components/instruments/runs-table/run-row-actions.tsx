"use client";

import {
  ArrowDownToLine,
  ArrowUpToLine,
  Loader2,
  MoreHorizontal,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type MouseEvent, useState, useTransition } from "react";
import { toast } from "sonner";
import { DeleteRunsDialog } from "@/components/runs/delete-runs-dialog";
import { ReprocessRunsDialog } from "@/components/runs/reprocess-runs-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useArchiveDownload } from "@/hooks/use-archive-download";
import { computeRunCaps, reprocessableFileCount } from "@/lib/runs/row-actions";
import { cn } from "@/lib/utils";
import type { RunRow } from ".";

// Actions cell shown inline at the end of every runs-table row. The strip is
// hidden until the row is hovered / focused within (matches the mockup),
// and individual icons are conditionally rendered based on the run's
// capabilities so we never show an action the server will reject.
//
// Buttons stop click propagation as a defensive measure so dropdown / dialog
// triggers inside the cell don't bubble to ancestor click handlers.

function swallow(e: MouseEvent) {
  e.stopPropagation();
}

export function RunRowActions({ row }: { row: RunRow }) {
  const caps = computeRunCaps(row);
  const router = useRouter();
  const { actions: archiveActions } = useArchiveDownload();
  const [isPending, startTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Deleted rows get no actions — the row is read-only.
  if (row.deleted_at !== null) {
    return null;
  }

  const baseUrl = `/api/v1/instruments/${row.instrument_id}/runs/${encodeURIComponent(
    row.run_id
  )}`;

  function handleUpload(e: MouseEvent) {
    e.stopPropagation();
    startTransition(async () => {
      const res = await fetch(`${baseUrl}/request-upload-all`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to request upload");
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        files_queued?: number;
      } | null;
      const queued = body?.files_queued ?? 0;
      toast.success(
        queued > 0
          ? `Upload requested for ${queued} file${queued === 1 ? "" : "s"}`
          : "No new files to upload"
      );
      router.refresh();
    });
  }

  // The download is delegated to `ArchiveDownloadProvider`: small/cached
  // archives stream to the browser inside the same user gesture (302/JSON
  // path); large archives surface a status dialog and notify when ready.
  function handleDownload(e: MouseEvent) {
    e.stopPropagation();
    void archiveActions.start({
      archiveUrl: `${baseUrl}/download-archive`,
      runId: row.run_id,
      defaultFilename: `${row.run_id}.zip`,
    });
  }

  return (
    <div
      className={cn(
        "flex items-center justify-end gap-1 opacity-0 transition-opacity",
        "group-focus-within:opacity-100 group-hover:opacity-100",
        (menuOpen || reprocessOpen || deleteOpen) && "opacity-100"
      )}
      onClick={swallow}
    >
      {caps.upload && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Upload files from this run"
              className="size-7"
              disabled={isPending}
              onClick={handleUpload}
              size="icon"
              type="button"
              variant="outline"
            >
              {isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ArrowUpToLine className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Upload files from this run</TooltipContent>
        </Tooltip>
      )}

      {caps.download && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Download run archive"
              className="size-7"
              onClick={handleDownload}
              size="icon"
              type="button"
              variant="outline"
            >
              <ArrowDownToLine className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download run archive</TooltipContent>
        </Tooltip>
      )}

      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More actions"
            className="size-7"
            onClick={swallow}
            size="icon"
            type="button"
            variant="outline"
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40" onClick={swallow}>
          {caps.reprocess && (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setMenuOpen(false);
                setReprocessOpen(true);
              }}
            >
              <RotateCw className="size-3.5" />
              Reprocess run
            </DropdownMenuItem>
          )}
          {caps.reprocess && caps.delete && <DropdownMenuSeparator />}
          {caps.delete && (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
              variant="destructive"
            >
              <Trash2 className="size-3.5" />
              Delete run
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ReprocessRunsDialog
        onOpenChange={setReprocessOpen}
        open={reprocessOpen}
        runs={[
          {
            instrumentId: row.instrument_id,
            runId: row.run_id,
            eligibleFileCount: reprocessableFileCount(row),
          },
        ]}
      />
      <DeleteRunsDialog
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        runs={[
          {
            instrumentId: row.instrument_id,
            runId: row.run_id,
            fileCount: row.file_count,
            hasProcessedFiles: row.files_completed + row.files_failed > 0,
          },
        ]}
      />
    </div>
  );
}
