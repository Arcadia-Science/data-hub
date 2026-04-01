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
import { Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

export function DeregisterDialog({
  watcherId,
  hostname,
}: {
  watcherId: string;
  hostname: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Soft-deletes the watcher via the existing API (sets deleted_at). The
  // watcher CLI will receive a 404 on its next heartbeat and shut down.
  // useTransition keeps the dialog responsive during the network round-trip.
  function handleDeregister() {
    startTransition(async () => {
      const res = await fetch(`/api/v1/watchers/${watcherId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to deregister watcher");
        return;
      }

      toast.success("Watcher deregistered");
      // Invalidate the server component tree so the watcher disappears from
      // the active list (or shifts to the deregistered partition).
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
        >
          <Trash2 className="size-3" />
          Deregister
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
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
            variant="destructive"
            onClick={handleDeregister}
            disabled={isPending}
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Deregister
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
