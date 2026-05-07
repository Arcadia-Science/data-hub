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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

export function DeleteRunDialog({
  instrumentId,
  runId,
  fileCount,
  hasProcessedFiles,
}: {
  instrumentId: string;
  runId: string;
  fileCount: number;
  hasProcessedFiles: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmValue, setConfirmValue] = useState("");
  const [open, setOpen] = useState(false);

  // Runs with processed files require typing the run ID to confirm deletion
  // because regenerating them (plate maps, images) is expensive.
  const requiresConfirmation = hasProcessedFiles;
  const isConfirmed = !requiresConfirmation || confirmValue === runId;

  function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch(
        `/api/v1/instruments/${instrumentId}/runs/${runId}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to delete run");
        return;
      }

      toast.success("Run deleted");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
        >
          <Trash2 className="size-3" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete run?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This will soft-delete the run{" "}
                <strong className="font-mono">{runId}</strong>
                {fileCount > 0 && <> and its {fileCount} file(s)</>}. The run
                can be restored at any time.
              </p>
              {requiresConfirmation && (
                <div className="space-y-1.5 pt-2">
                  <Label htmlFor="confirm-run-id" className="text-xs">
                    Type <strong className="font-mono">{runId}</strong> to
                    confirm
                  </Label>
                  <Input
                    id="confirm-run-id"
                    value={confirmValue}
                    onChange={(e) => setConfirmValue(e.target.value)}
                    placeholder={runId}
                    className="font-mono text-sm"
                    autoComplete="off"
                  />
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmValue("")}>
            Cancel
          </AlertDialogCancel>
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
