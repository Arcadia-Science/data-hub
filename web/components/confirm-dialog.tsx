"use client";

import { Loader2 } from "lucide-react";
import { type ReactNode, useTransition } from "react";
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
import { useReturnFocus } from "@/hooks/use-return-focus";

/**
 * Asks before an action that is hard to undo. The dialog stays open with a
 * spinner while `onConfirm` runs, so a failed request leaves the choice on
 * screen instead of closing as if it worked. `onConfirm` returns true when the
 * action succeeded, and the dialog closes then. Open state belongs to the
 * caller, which lets a switch or a menu item open it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  variant = "default",
  onConfirm,
}: {
  confirmLabel: string;
  description: ReactNode;
  onConfirm: () => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  variant?: "default" | "destructive";
}) {
  const [isPending, startTransition] = useTransition();
  const returnFocus = useReturnFocus();

  function handleConfirm(event: React.MouseEvent) {
    // The action button closes the dialog by default. Wait for the result.
    event.preventDefault();
    startTransition(async () => {
      let succeeded = false;
      try {
        succeeded = await onConfirm();
      } catch {
        toast.error("Something went wrong. Try again.");
      }
      if (succeeded) {
        // A transition, so the dialog stays until the page refresh that
        // `onConfirm` started has landed.
        startTransition(() => onOpenChange(false));
      }
    });
  }

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!isPending) {
          onOpenChange(next);
        }
      }}
      open={open}
    >
      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={handleConfirm}
            variant={variant}
          >
            {isPending ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
