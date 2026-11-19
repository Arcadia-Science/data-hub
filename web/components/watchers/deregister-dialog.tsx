"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type MouseEvent, type RefObject, useTransition } from "react";
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
import { apiErrorMessage } from "@/lib/api/errors";

export function DeregisterDialog({
  watcherId,
  hostname,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  watcherId: string;
  hostname: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The control to focus when the dialog closes. A dialog opened from a menu
   * item can't tell what to return to: the menu has closed by the time the
   * dialog opens, so pass the menu's trigger.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const returnFocus = useReturnFocus();
  const contentFocus = {
    ...returnFocus,
    onCloseAutoFocus(event: Event) {
      const target = returnFocusRef?.current;
      if (target?.isConnected) {
        event.preventDefault();
        target.focus();
        return;
      }
      returnFocus.onCloseAutoFocus(event);
    },
  };

  // Soft-deletes the watcher via the existing API (sets deleted_at). The
  // watcher CLI will receive a 404 on its next heartbeat and shut down.
  // useTransition keeps the dialog responsive during the network round-trip.
  function handleDeregister(e: MouseEvent) {
    // Keep the dialog open until the request finishes so the spinner stays
    // visible; we close it ourselves on success.
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch(`/api/v1/watchers/${watcherId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(apiErrorMessage(body, "Failed to deregister watcher"));
        return;
      }

      toast.success("Watcher deregistered");
      onOpenChange(false);
      // Invalidate the server component tree so the watcher disappears from
      // the active list (or shifts to the deregistered partition).
      router.refresh();
    });
  }

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent {...contentFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Deregister watcher?</AlertDialogTitle>
          <AlertDialogDescription>
            Stop the watcher service on the instrument PC before deregistering.
            {hostname && (
              <>
                {" "}
                The watcher on <strong>{hostname}</strong> will no longer be
                able to send heartbeats or events.
              </>
            )}
            {!hostname &&
              " The watcher will no longer be able to send heartbeats or events."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={handleDeregister}
            variant="destructive"
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Deregister
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
