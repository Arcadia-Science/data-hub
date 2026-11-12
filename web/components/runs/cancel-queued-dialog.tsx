"use client";

import { ListX, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cancelQueuedToast } from "@/lib/runs/cancel-queued";

// The run page's "Cancel queued" button. It takes every file that is waiting in
// the reprocessing queue out of the queue. The page shows it only while the run
// has queued files (see `canCancelQueued`).
export function CancelQueuedDialog({
  instrumentId,
  runId,
  queuedCount,
}: {
  instrumentId: string;
  runId: string;
  // Queued files shown on the page when it rendered.
  queuedCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(e: React.MouseEvent) {
    // Keep the dialog open until the request ends, so the spinner shows. The
    // button stays focusable while it works, so a second click is ignored.
    e.preventDefault();
    if (isPending) {
      return;
    }
    startTransition(async () => {
      const res = await fetch(
        `/api/v1/instruments/${encodeURIComponent(instrumentId)}/runs/${encodeURIComponent(runId)}/cancel-queued`,
        { method: "POST" }
      );
      const body = await res.json().catch(() => null);
      if (res.ok) {
        const { kind, message } = cancelQueuedToast(
          typeof body?.files_cancelled === "number" ? body.files_cancelled : 0
        );
        toast[kind](message);
      } else {
        toast.error(
          body?.error?.message ?? "Failed to cancel the queued files"
        );
      }
      setOpen(false);
      router.refresh();
    });
  }

  const noun = queuedCount === 1 ? "file" : "files";

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger asChild>
        <Button className="gap-1.5 text-sm" size="sm" variant="outline">
          <ListX className="size-4" />
          Cancel queued
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Cancel {queuedCount} queued {noun}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {queuedCount === 1 ? "This file is" : "These files are"} waiting for
            a free processing slot and {queuedCount === 1 ? "has" : "have"} not
            started. Cancelling takes {queuedCount === 1 ? "it" : "them"} out of
            the queue. {queuedCount === 1 ? "It" : "They"} will show{" "}
            <em>Failed</em> with a message that says the reprocess was
            cancelled, and you can reprocess {queuedCount === 1 ? "it" : "them"}{" "}
            again later. Files that have already started are not affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep queued</AlertDialogCancel>
          <AlertDialogAction aria-disabled={isPending} onClick={handleConfirm}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Cancel queued
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
