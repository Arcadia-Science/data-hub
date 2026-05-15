"use client";

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
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

export type DeleteRunTarget = {
  instrumentId: string;
  runId: string;
  fileCount: number;
  hasProcessedFiles: boolean;
};

// ---------------------------------------------------------------------------
// Controlled delete dialog shared by the row "..." menu and the bulk action
// bar. For a single run with processed files, reuses the same "type the run
// ID" confirmation gate as the detail-page DeleteRunDialog. For bulk, per
// product clarification, a simple confirm is enough.
// ---------------------------------------------------------------------------

async function fanOut(
  runs: DeleteRunTarget[]
): Promise<{ ok: number; failed: number }> {
  const results = await Promise.all(
    runs.map(async (r) => {
      try {
        const res = await fetch(
          `/api/v1/instruments/${r.instrumentId}/runs/${encodeURIComponent(r.runId)}`,
          { method: "DELETE" }
        );
        return res.ok;
      } catch {
        return false;
      }
    })
  );
  const ok = results.filter(Boolean).length;
  return { ok, failed: results.length - ok };
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

  const runCount = runs.length;
  const isSingle = runCount === 1;
  const singleRun = isSingle ? runs[0]! : null;
  const totalFiles = runs.reduce((sum, r) => sum + r.fileCount, 0);

  // Single-run with processed files keeps the strict gate so an accidental
  // delete can't wipe expensive processed artifacts. Bulk deletes don't
  // require typing (per product clarification).
  const requiresTypeConfirm = isSingle && singleRun!.hasProcessedFiles;
  const isConfirmed = !requiresTypeConfirm || confirmValue === singleRun!.runId;

  function handleOpenChange(next: boolean) {
    if (!next) setConfirmValue("");
    onOpenChange(next);
  }

  function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    startTransition(async () => {
      const { ok, failed } = await fanOut(runs);
      if (failed === 0) {
        toast.success(`Deleted ${ok} ${ok === 1 ? "run" : "runs"}`);
      } else if (ok === 0) {
        toast.error(
          `Failed to delete ${failed} ${failed === 1 ? "run" : "runs"}`
        );
      } else {
        toast.warning(
          `Deleted ${ok} ${ok === 1 ? "run" : "runs"}, ${failed} failed`
        );
      }
      handleOpenChange(false);
      onComplete?.();
      router.refresh();
    });
  }

  const title = isSingle ? "Delete run?" : `Delete ${runCount} runs?`;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {isSingle ? (
                <p>
                  This will soft-delete the run{" "}
                  <strong className="font-mono">{singleRun!.runId}</strong>
                  {singleRun!.fileCount > 0 && (
                    <> and its {singleRun!.fileCount} file(s)</>
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
              {requiresTypeConfirm && (
                <div className="space-y-1.5 pt-2">
                  <Label htmlFor="confirm-run-id" className="text-xs">
                    Type{" "}
                    <strong className="font-mono">{singleRun!.runId}</strong> to
                    confirm
                  </Label>
                  <Input
                    id="confirm-run-id"
                    value={confirmValue}
                    onChange={(e) => setConfirmValue(e.target.value)}
                    placeholder={singleRun!.runId}
                    className="font-mono text-sm"
                    autoComplete="off"
                  />
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending || !isConfirmed}
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
