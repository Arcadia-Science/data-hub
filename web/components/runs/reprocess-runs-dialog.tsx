"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  REPROCESS_REQUEST_CONCURRENCY,
  settleWithConcurrency,
} from "@/lib/runs/settle-with-concurrency";

export interface ReprocessRunTarget {
  // Pre-summed by the caller via `reprocessableFileCount` so the dialog never
  // has to know which file states the endpoint will pick up.
  eligibleFileCount: number;
  instrumentId: string;
  runId: string;
}

// ---------------------------------------------------------------------------
// Controlled reprocess dialog used by both the per-row "..." menu (single
// run) and the bulk action bar. Accepts an array of runs so the same
// component handles both shapes — the caller owns the open state because
// the dialog is launched from a dropdown item / bulk bar button rather
// than via an AlertDialogTrigger.
// ---------------------------------------------------------------------------

async function fanOut(
  runs: ReprocessRunTarget[]
): Promise<{ ok: number; failed: number; filesQueued: number }> {
  // A few runs at a time: each request queues every eligible file of its run.
  const results = await settleWithConcurrency(
    runs,
    REPROCESS_REQUEST_CONCURRENCY,
    async (r) => {
      const url = `/api/v1/instruments/${r.instrumentId}/runs/${encodeURIComponent(
        r.runId
      )}/reprocess`;
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const body = (await res.json()) as { files_queued?: number };
      return body.files_queued ?? 0;
    }
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

export function ReprocessRunsDialog({
  open,
  onOpenChange,
  runs,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runs: ReprocessRunTarget[];
  onComplete?: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const runCount = runs.length;
  const eligibleFiles = runs.reduce((sum, r) => sum + r.eligibleFileCount, 0);

  function handleConfirm(e: React.MouseEvent) {
    e.preventDefault();
    startTransition(async () => {
      const { ok, failed, filesQueued } = await fanOut(runs);
      if (failed === 0) {
        toast.success(
          `Queued ${filesQueued} ${filesQueued === 1 ? "file" : "files"} for reprocessing across ${ok} ${ok === 1 ? "run" : "runs"}`
        );
      } else if (ok === 0) {
        toast.error(`Failed to start reprocessing for ${failed} runs`);
      } else {
        toast.warning(
          `Queued ${ok} ${ok === 1 ? "run" : "runs"} for reprocessing; ${failed} failed`
        );
      }
      onOpenChange(false);
      onComplete?.();
      router.refresh();
    });
  }

  const title =
    runCount === 1
      ? `Reprocess run ${runs[0]?.runId}?`
      : `Reprocess ${runCount} runs?`;

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            This will queue <strong>{eligibleFiles}</strong>{" "}
            {eligibleFiles === 1 ? "file" : "files"} for reprocessing.{" "}
            {eligibleFiles === 1 ? "It is" : "They are"} currently in the{" "}
            <em>uploaded</em>, <em>completed</em>, or <em>failed</em> state, or
            stuck in <em>processing</em>. Each file starts as soon as a
            processing slot is free, so some may wait as <em>queued</em>.
            Results will overwrite any existing processed artifacts.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={isPending} onClick={handleConfirm}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Reprocess
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
