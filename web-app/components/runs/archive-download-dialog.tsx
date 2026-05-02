"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

import type { ArchiveDownloadJob } from "./archive-download-provider";

// Show the dialog any time at least one job is mid-flight or in a terminal
// state the user hasn't dismissed yet. The provider auto-dismisses ready
// jobs after a short delay, so the only sticky rows are async builds and
// failures. Multiple concurrent jobs (e.g. bulk download) are stacked.

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds - mins * 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

export function ArchiveDownloadDialog({
  jobs,
  onDismiss,
}: {
  jobs: ArchiveDownloadJob[];
  onDismiss: (id: string) => void;
}) {
  // The provider hides cache-hits from the dialog by auto-dismissing them.
  // Only show jobs that are still building, failed, or freshly ready.
  const visible = jobs.filter(
    (j) => j.status === "building" || j.status === "failed"
  );
  const open = visible.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing the dialog dismisses every visible row. Building rows are
        // forfeit on close — the build itself continues server-side and the
        // archive will be available via the cache key on the next click.
        if (!next) for (const j of visible) onDismiss(j.id);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Preparing archive download</DialogTitle>
          <DialogDescription>
            Large archives are built on the server and downloaded directly from
            S3 once ready. This dialog will close automatically when the
            download starts.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-3 py-2">
          {visible.map((job) => (
            <li
              key={job.id}
              className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                {job.status === "building" ? (
                  <Loader2
                    className="size-4 shrink-0 animate-spin text-muted-foreground"
                    aria-hidden
                  />
                ) : (
                  <span
                    className="inline-block size-2 shrink-0 rounded-full bg-destructive"
                    aria-hidden
                  />
                )}
                <div className="min-w-0">
                  <div className="truncate font-medium">{job.runId}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {job.status === "building"
                      ? `Building... ${formatElapsed(job.startedAt)}`
                      : (job.errorMessage ?? "Failed")}
                  </div>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDismiss(job.id)}
              >
                {job.status === "building" ? "Hide" : "Dismiss"}
              </Button>
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              for (const j of visible) onDismiss(j.id);
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
