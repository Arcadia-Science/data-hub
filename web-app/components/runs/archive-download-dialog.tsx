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
import { useEffect, useState } from "react";

import type { ArchiveDownloadJob } from "./archive-download-provider";

// Show the dialog any time at least one job is mid-flight or in a terminal
// state the user hasn't dismissed yet. The provider auto-dismisses ready
// jobs after a short delay, so the only sticky rows are async builds and
// failures. Multiple concurrent jobs (e.g. bulk download) are stacked.

function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds - mins * 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

// Drives a once-per-second re-render so the elapsed counter on building rows
// actually ticks. Without this, the dialog only re-renders on status
// transitions (which for a long async build is essentially never between
// `pending → building` and `building → ready/failed`), so the counter would
// freeze at "0s" for the entire wait. Skips the interval entirely when no
// rows are building to keep the steady-state cost zero.
//
// When `active` flips false → true after a long idle (the provider keeps
// this dialog mounted for the whole session, so `now` may be stale by
// hours), the displayed value is briefly clamped to "0s" by `formatElapsed`'s
// `Math.max(0, …)` until the first interval tick lands ≤ 1 s later — which
// matches reality, since the row is brand new at that point.
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
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
  const hasBuilding = visible.some((j) => j.status === "building");
  const now = useNowTick(hasBuilding);

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

        <ul className="min-w-0 space-y-3 py-2">
          {visible.map((job) => (
            <li
              key={job.id}
              className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
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
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{job.runId}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {job.status === "building"
                      ? `Building... ${formatElapsed(job.startedAt, now)}`
                      : (job.errorMessage ?? "Failed")}
                  </div>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
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
