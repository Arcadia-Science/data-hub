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

export interface ReprocessRunTarget {
  filesCompleted: number;
  filesFailed: number;
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
  const results = await Promise.allSettled(
    runs.map(async (r) => {
      const url = `/api/v1/instruments/${r.instrumentId}/runs/${encodeURIComponent(
        r.runId
      )}/reprocess`;
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        throw new Error(await res.text());
      }
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
  const eligibleFiles = runs.reduce(
    (sum, r) => sum + r.filesCompleted + r.filesFailed,
    0
  );

  function handleConfirm(e: React.MouseEvent) {
    e.preventDefault();
    startTransition(async () => {
      const { ok, failed, filesQueued } = await fanOut(runs);
      if (failed === 0) {
        toast.success(
          `Reprocessing ${filesQueued} ${filesQueued === 1 ? "file" : "files"} across ${ok} ${ok === 1 ? "run" : "runs"}`
        );
      } else if (ok === 0) {
        toast.error(`Failed to start reprocessing for ${failed} runs`);
      } else {
        toast.warning(
          `Reprocessing ${ok} ${ok === 1 ? "run" : "runs"}; ${failed} failed`
        );
      }
      onOpenChange(false);
      onComplete?.();
      router.refresh();
    });
  }

  const title =
    runCount === 1
      ? `Reprocess run ${runs[0]!.runId}?`
      : `Reprocess ${runCount} runs?`;

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            This will re-run the processing pipeline on{" "}
            <strong>{eligibleFiles}</strong>{" "}
            {eligibleFiles === 1 ? "file" : "files"} currently in the{" "}
            <em>completed</em> or <em>failed</em> state. Results will overwrite
            any existing processed artifacts.
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
