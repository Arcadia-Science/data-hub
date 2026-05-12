"use client";

import { DeleteRunsDialog } from "@/components/runs/delete-runs-dialog";
import { ReprocessRunsDialog } from "@/components/runs/reprocess-runs-dialog";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useArchiveDownload } from "@/hooks/use-archive-download";
import { cn } from "@/lib/utils";
import { ArrowDownToLine, ArrowUpToLine, RotateCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { useRunSelection, type RunRef } from "./run-selection-provider";

// ---------------------------------------------------------------------------
// Bulk action bar shown as a floating card pinned to the center bottom of
// the viewport when at least one run is selected. Floating (rather than
// inline above the table) so the table doesn't jump down on the user after
// the first selection. The original BulkAttributionBar only surfaced
// attribution actions; this extends it with upload / download / reprocess
// / delete.
//
// Per product clarification, an action is shown only when every selected
// run supports it — a mixed selection collapses back to attribution +
// delete so we never offer a button that would succeed on some rows and
// silently skip others.
// ---------------------------------------------------------------------------

type AttributionMethod = "PUT" | "DELETE";

async function fanOutAttribution(
  method: AttributionMethod,
  refs: RunRef[]
): Promise<{ ok: number; failed: number }> {
  const results = await Promise.all(
    refs.map(async (ref) => {
      const url = `/api/v1/instruments/${ref.instrumentId}/runs/${encodeURIComponent(
        ref.runId
      )}/attributions/me`;
      try {
        const res = await fetch(url, { method });
        return res.ok;
      } catch {
        return false;
      }
    })
  );
  const ok = results.filter(Boolean).length;
  return { ok, failed: results.length - ok };
}

async function fanOutUpload(
  refs: RunRef[]
): Promise<{ ok: number; failed: number; filesQueued: number }> {
  const results = await Promise.allSettled(
    refs.map(async (ref) => {
      const url = `/api/v1/instruments/${ref.instrumentId}/runs/${encodeURIComponent(
        ref.runId
      )}/request-upload-all`;
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as { files_queued?: number };
      return body.files_queued ?? 0;
    })
  );
  let ok = 0;
  let failed = 0;
  let filesQueued = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      ok += 1;
      filesQueued += r.value;
    } else {
      failed += 1;
    }
  }
  return { ok, failed, filesQueued };
}

export function RunBulkActionBar() {
  const { state, actions, meta } = useRunSelection();
  const router = useRouter();
  const { actions: archiveActions } = useArchiveDownload();
  const { state: sidebarState, isMobile } = useSidebar();
  const [isPending, startTransition] = useTransition();
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (meta.count === 0) return null;

  const refs = Array.from(state.selected.values());

  function runAttribution(method: AttributionMethod, label: string) {
    startTransition(async () => {
      const { ok, failed } = await fanOutAttribution(method, refs);
      if (failed === 0) {
        toast.success(`${label} ${ok} ${ok === 1 ? "run" : "runs"}.`);
      } else if (ok === 0) {
        toast.error(
          `Failed to update ${failed} ${failed === 1 ? "run" : "runs"}.`
        );
      } else {
        toast.warning(
          `${label} ${ok} ${ok === 1 ? "run" : "runs"}, ${failed} failed.`
        );
      }
      actions.clear();
      router.refresh();
    });
  }

  function runUpload() {
    startTransition(async () => {
      const { ok, failed, filesQueued } = await fanOutUpload(refs);
      if (failed === 0) {
        toast.success(
          filesQueued > 0
            ? `Upload requested for ${filesQueued} file${filesQueued === 1 ? "" : "s"} across ${ok} ${ok === 1 ? "run" : "runs"}`
            : "No new files to upload"
        );
      } else if (ok === 0) {
        toast.error(`Failed to request upload for ${failed} runs`);
      } else {
        toast.warning(
          `Upload requested for ${ok} ${ok === 1 ? "run" : "runs"}, ${failed} failed`
        );
      }
      actions.clear();
      router.refresh();
    });
  }

  // Bulk download fans the start() calls out one-after-another. Awaiting
  // each kickoff serializes the route's HEAD + INSERT + Lambda-POST so a
  // 50-run selection doesn't thunder the API with parallel requests; the
  // actual S3 builds still happen concurrently inside Lambda once each
  // kickoff returns. We also swallow individual failures so one bad ref
  // can't abort the rest of the bulk download.
  //
  // `void` on the IIFE is intentional: React event handlers can't return
  // promises without a wrapper.
  function handleDownload() {
    void (async () => {
      for (const ref of refs) {
        try {
          await archiveActions.start({
            archiveUrl: `/api/v1/instruments/${ref.instrumentId}/runs/${encodeURIComponent(
              ref.runId
            )}/download-archive`,
            runId: ref.runId,
            defaultFilename: `${ref.runId}.zip`,
          });
        } catch (err) {
          console.error(`Failed to start download for ${ref.runId}:`, err);
        }
      }
    })();
    toast.success(
      `Preparing ${refs.length} ${refs.length === 1 ? "archive" : "archives"}`
    );
  }

  const deleteTargets = refs.map((r) => ({
    instrumentId: r.instrumentId,
    runId: r.runId,
    fileCount: r.stats.fileCount,
    hasProcessedFiles: r.stats.filesCompleted + r.stats.filesFailed > 0,
  }));

  const reprocessTargets = refs.map((r) => ({
    instrumentId: r.instrumentId,
    runId: r.runId,
    filesCompleted: r.stats.filesCompleted,
    filesFailed: r.stats.filesFailed,
  }));

  // On desktop the expanded sidebar reserves space on the left, so anchor the
  // bar to the center of the main panel (not the viewport) by shifting `left`
  // by half the sidebar width. On mobile the sidebar is an overlay sheet, so
  // the main panel already spans the full viewport.
  const offsetForSidebar = !isMobile && sidebarState === "expanded";

  return (
    <>
      <div
        role="region"
        aria-label="Bulk actions for selected runs"
        className={cn(
          "fixed bottom-6 z-50 flex -translate-x-1/2 animate-in items-center gap-8 rounded-lg border bg-popover px-8 py-2.5 text-popover-foreground shadow-xl transition-[left] duration-200 ease-linear fade-in slide-in-from-bottom-4",
          offsetForSidebar
            ? "left-[calc(50%+var(--sidebar-width)/2)]"
            : "left-1/2"
        )}
      >
        <div className="text-sm">
          <span className="font-medium">{meta.count}</span>{" "}
          <span className="text-muted-foreground">
            {meta.count === 1 ? "run" : "runs"} selected
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={isPending}
            onClick={() => runAttribution("PUT", "Claimed")}
          >
            I ran these
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => runAttribution("DELETE", "Removed attribution from")}
          >
            Remove my attribution
          </Button>

          {meta.allCanUpload && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={runUpload}
                  className="gap-1.5"
                >
                  <ArrowUpToLine className="size-3.5" />
                  Upload
                </Button>
              </TooltipTrigger>
              <TooltipContent>Request upload for selected runs</TooltipContent>
            </Tooltip>
          )}

          {meta.allCanDownload && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  className="gap-1.5"
                >
                  <ArrowDownToLine className="size-3.5" />
                  Download
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download zip archive for each run</TooltipContent>
            </Tooltip>
          )}

          {meta.allCanReprocess && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => setReprocessOpen(true)}
              className="gap-1.5"
            >
              <RotateCw className="size-3.5" />
              Reprocess
            </Button>
          )}

          {meta.allCanDelete && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => setDeleteOpen(true)}
              className="gap-1.5 text-destructive hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          )}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => actions.clear()}
          >
            Clear
          </Button>
        </div>
      </div>

      <ReprocessRunsDialog
        open={reprocessOpen}
        onOpenChange={setReprocessOpen}
        runs={reprocessTargets}
        onComplete={() => actions.clear()}
      />
      <DeleteRunsDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        runs={deleteTargets}
        onComplete={() => actions.clear()}
      />
    </>
  );
}
