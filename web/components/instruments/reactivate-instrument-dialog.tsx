"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { type MouseEvent, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Sets the instrument back to `active`. Previously deregistered watchers do
// not reconnect automatically — a watcher must re-register.
export function ReactivateInstrumentDialog({
  instrumentId,
  displayName,
  open,
  onOpenChange,
}: {
  instrumentId: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleReactivate(e: MouseEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch(`/api/v1/instruments/${instrumentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to reactivate instrument");
        return;
      }

      toast.success("Instrument reactivated");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <RotateCcw />
          </AlertDialogMedia>
          <AlertDialogTitle>Reactivate {displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            The instrument returns to Active and reappears in the sidebar and
            dashboard. Any watchers deregistered when it was retired must
            re-register to reconnect.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={isPending} onClick={handleReactivate}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Reactivate instrument
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
