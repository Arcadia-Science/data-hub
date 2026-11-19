"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  NotebookRequestError,
  restoreNotebook,
} from "@/lib/runs/notebook-requests";

/** Brings back a deleted notebook, with the runs it had. */
export function RestoreNotebookButton({ notebookId }: { notebookId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleRestore() {
    startTransition(async () => {
      try {
        await restoreNotebook(notebookId);
      } catch (error) {
        // 409 means it's already restored, so the refresh shows it as live.
        if (!(error instanceof NotebookRequestError && error.status === 409)) {
          toast.error(
            error instanceof NotebookRequestError
              ? error.message
              : "Couldn't restore the notebook. Try again?"
          );
          return;
        }
      }
      toast.success("Notebook restored");
      router.refresh();
    });
  }

  return (
    <Button
      className="gap-1.5 text-sm"
      disabled={isPending}
      onClick={handleRestore}
      size="sm"
      type="button"
      variant="outline"
    >
      {isPending ? (
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      ) : (
        <RotateCcw aria-hidden="true" className="size-4" />
      )}
      Restore
    </Button>
  );
}
