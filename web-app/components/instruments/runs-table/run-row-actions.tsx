"use client";

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
import { computeRunCaps } from "@/lib/runs/row-actions";
import { cn } from "@/lib/utils";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Loader2,
  MoreHorizontal,
  RotateCw,
  Trash2,
  UserRoundPlus,
  UserRoundX,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type MouseEvent } from "react";
import { toast } from "sonner";

import { DeleteRunsDialog } from "@/components/runs/delete-runs-dialog";
import { ReprocessRunsDialog } from "@/components/runs/reprocess-runs-dialog";
import type { RunRow } from ".";

// Actions cell shown inline at the end of every runs-table row. The strip is
// hidden until the row is hovered / focused within (matches the mockup),
// and individual icons are conditionally rendered based on the run's
// capabilities so we never show an action the server will reject.
//
// All buttons stop click propagation so interacting with them doesn't
// trigger the row-level navigation on ClickableRow.

function swallow(e: MouseEvent) {
  e.stopPropagation();
}

export function RunRowActions({ row }: { row: RunRow }) {
  const caps = computeRunCaps(row);
  const router = useRouter();
  const { data: session } = useSession();
  const [isPending, startTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Deleted rows get no actions — the row is read-only.
  if (row.deleted_at !== null) return null;

  const currentUserId = session?.user?.id ?? null;
  const isSelfAttributed =
    currentUserId !== null &&
    row.attributions.some((a) => a.userId === currentUserId);

  const baseUrl = `/api/v1/instruments/${row.instrument_id}/runs/${encodeURIComponent(
    row.run_id
  )}`;

  function handleAttributionToggle(e: MouseEvent) {
    e.stopPropagation();
    if (!currentUserId) return;
    const method = isSelfAttributed ? "DELETE" : "PUT";
    startTransition(async () => {
      try {
        const res = await fetch(`${baseUrl}/attributions/me`, { method });
        if (!res.ok) throw new Error(await res.text());
      } catch {
        toast.error(
          isSelfAttributed
            ? "Couldn't remove attribution. Try again?"
            : "Couldn't claim this run. Try again?"
        );
      } finally {
        router.refresh();
      }
    });
  }

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

  // The download endpoint streams a zip; let the browser handle it as a
  // normal navigation via an anchor we construct on the fly. Using a real
  // <a> (vs fetch) preserves Content-Disposition and lets the browser name
  // the file correctly. The `download` attribute forces download semantics
  // even when Content-Disposition is missing on a failed response.
  function handleDownload(e: MouseEvent) {
    e.stopPropagation();
    const a = document.createElement("a");
    a.href = `${baseUrl}/download-archive`;
    a.download = `${row.run_id}.zip`;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
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
      {currentUserId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7"
              disabled={isPending}
              onClick={handleAttributionToggle}
              aria-label={
                isSelfAttributed ? "Remove my attribution" : "I ran this"
              }
            >
              {isSelfAttributed ? (
                <UserRoundX className="size-3.5" />
              ) : (
                <UserRoundPlus className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isSelfAttributed ? "Remove my attribution" : "I ran this"}
          </TooltipContent>
        </Tooltip>
      )}

      {caps.upload && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7"
              disabled={isPending}
              onClick={handleUpload}
              aria-label="Upload files from this run"
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
              type="button"
              variant="outline"
              size="icon"
              className="size-7"
              onClick={handleDownload}
              aria-label="Download run archive"
            >
              <ArrowDownToLine className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download run archive</TooltipContent>
        </Tooltip>
      )}

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7"
            aria-label="More actions"
            onClick={swallow}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={swallow}>
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
              variant="destructive"
              onSelect={(e) => {
                e.preventDefault();
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
            >
              <Trash2 className="size-3.5" />
              Delete run
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ReprocessRunsDialog
        open={reprocessOpen}
        onOpenChange={setReprocessOpen}
        runs={[
          {
            instrumentId: row.instrument_id,
            runId: row.run_id,
            filesCompleted: row.files_completed,
            filesFailed: row.files_failed,
          },
        ]}
      />
      <DeleteRunsDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
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
