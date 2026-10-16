"use client";

import { Loader2 } from "lucide-react";
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
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useReturnFocus } from "@/hooks/use-return-focus";

export interface DeleteRunTarget {
  fileCount: number;
  hasProcessedFiles: boolean;
  instrumentId: string;
  runId: string;
}

// Shared by the run page's Delete button, the list's row menu, and the bulk
// action bar. One run with processed files asks for its run ID to be typed;
// several runs need only a confirm.

// Deletes every run and keeps the first error message the server gave, so a
// run that cannot be deleted can say why.
async function deleteRuns(
  runs: DeleteRunTarget[]
): Promise<{ failed: number; message: string | null; ok: number }> {
  const results = await Promise.all(
    runs.map(async (r) => {
      try {
        const res = await fetch(
          `/api/v1/instruments/${r.instrumentId}/runs/${encodeURIComponent(r.runId)}`,
          { method: "DELETE" }
        );
        if (res.ok) {
          return { ok: true, message: null };
        }
        const body = await res.json().catch(() => null);
        return { ok: false, message: body?.error?.message ?? null };
      } catch {
        return { ok: false, message: null };
      }
    })
  );
  const ok = results.filter((r) => r.ok).length;
  const message = results.find((r) => r.message !== null)?.message ?? null;
  return { ok, failed: results.length - ok, message };
}

export function DeleteRunsDialog({
  open,
  onOpenChange,
  runs,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runs: DeleteRunTarget[];
  onComplete?: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmValue, setConfirmValue] = useState("");
  const returnFocus = useReturnFocus();

  const runCount = runs.length;
  const singleRun = runCount === 1 ? runs[0] : undefined;
  const isSingle = singleRun !== undefined;
  const totalFiles = runs.reduce((sum, r) => sum + r.fileCount, 0);

  // Single-run with processed files keeps the strict gate so an accidental
  // delete can't wipe expensive processed artifacts. Bulk deletes don't
  // require typing (per product clarification).
  const requiresTypeConfirm = isSingle && singleRun.hasProcessedFiles;
  const isConfirmed = !requiresTypeConfirm || confirmValue === singleRun?.runId;

  function handleOpenChange(next: boolean) {
    // A request is running, so closing now would hide its result.
    if (isPending) {
      return;
    }
    if (!next) {
      setConfirmValue("");
    }
    onOpenChange(next);
  }

  function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    startTransition(async () => {
      const { ok, failed, message } = await deleteRuns(runs);
      if (ok === 0) {
        // Nothing was deleted, so the dialog stays open with the typed run ID
        // and the user can try again.
        toast.error(
          message ??
            (isSingle
              ? "Failed to delete run"
              : `Failed to delete ${failed} runs`)
        );
        return;
      }
      if (failed === 0) {
        toast.success(isSingle ? "Run deleted" : `Deleted ${ok} runs`);
      } else {
        toast.warning(
          `Deleted ${ok} ${ok === 1 ? "run" : "runs"}, ${failed} failed`
        );
      }
      startTransition(() => {
        setConfirmValue("");
        onOpenChange(false);
      });
      onComplete?.();
      router.refresh();
    });
  }

  const title = isSingle ? "Delete run?" : `Delete ${runCount} runs?`;

  return (
    <AlertDialog onOpenChange={handleOpenChange} open={open}>
      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {singleRun ? (
                <p>
                  This will soft-delete the run{" "}
                  <strong className="font-mono">{singleRun.runId}</strong>
                  {singleRun.fileCount > 0 && (
                    <> and its {singleRun.fileCount} file(s)</>
                  )}
                  . The run can be restored at any time.
                </p>
              ) : (
                <p>
                  This will soft-delete <strong>{runCount}</strong> runs and
                  their <strong>{totalFiles}</strong>{" "}
                  {totalFiles === 1 ? "file" : "files"}. The runs can be
                  restored at any time.
                </p>
              )}
              {requiresTypeConfirm && singleRun && (
                <div className="space-y-1.5 pt-2">
                  <Label className="text-xs" htmlFor="confirm-run-id">
                    Type{" "}
                    <strong className="font-mono">{singleRun.runId}</strong> to
                    confirm
                  </Label>
                  <Input
                    autoComplete="off"
                    className="font-mono text-sm"
                    id="confirm-run-id"
                    onChange={(e) => setConfirmValue(e.target.value)}
                    placeholder={singleRun.runId}
                    value={confirmValue}
                  />
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending || !isConfirmed}
            onClick={handleDelete}
            variant="destructive"
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
