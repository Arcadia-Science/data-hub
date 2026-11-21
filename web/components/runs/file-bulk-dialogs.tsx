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
import { useReturnFocus } from "@/hooks/use-return-focus";

// The confirmation for the files bar's Reprocess. The bar owns the
// open state, because a dialog opened from state has no trigger for Radix to
// return focus to, so `useReturnFocus` hands it back to the bar's button.

interface BulkFilesDialogProps {
  count: number;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function ReprocessFilesDialog({
  count,
  onConfirm,
  onOpenChange,
  open,
}: BulkFilesDialogProps) {
  const returnFocus = useReturnFocus();
  const noun = count === 1 ? "file" : "files";
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Reprocess {count} {noun}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Each selected file will be queued for reprocessing. Files start as
            processing slots free up, so some may wait as Queued. Any existing
            report data for these files will be cleared.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Reprocess</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
