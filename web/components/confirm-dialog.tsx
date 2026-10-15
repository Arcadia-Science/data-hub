"use client";

import { Loader2 } from "lucide-react";
import { type ReactNode, useTransition } from "react";
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
  destructive = false,
  onConfirm,
}: {
  confirmLabel: string;
  description: ReactNode;
  destructive?: boolean;
  onConfirm: () => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  const [isPending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent) {
    // The action button closes the dialog by default. Wait for the result.
    event.preventDefault();
    startTransition(async () => {
      if (await onConfirm()) {
        onOpenChange(false);
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
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={
              destructive
                ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                : undefined
            }
            disabled={isPending}
            onClick={handleConfirm}
          >
            {isPending ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            ) : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
