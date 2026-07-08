"use client";

import { Archive, Check, Loader2, Power } from "lucide-react";
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
import { cn } from "@/lib/utils";

// Sets the instrument to `inactive` (shown as "Retired"); the server always
// deregisters its watchers as part of the same request.
export function RetireInstrumentDialog({
  instrumentId,
  displayName,
  runCount,
  watcherCount,
  open,
  onOpenChange,
}: {
  instrumentId: string;
  displayName: string;
  runCount: number;
  watcherCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleRetire(e: MouseEvent) {
    // Prevent the AlertDialog from auto-closing before the request resolves so
    // the pending spinner stays visible until we explicitly close on success.
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch(`/api/v1/instruments/${instrumentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "inactive" }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to retire instrument");
        return;
      }

      toast.success("Instrument retired");
      onOpenChange(false);
      router.refresh();
    });
  }

  const hasWatchers = watcherCount > 0;

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Archive />
          </AlertDialogMedia>
          <AlertDialogTitle>Retire {displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            The instrument moves to Retired and disappears from the sidebar and
            dashboard. It stops accepting new runs and watchers.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="rounded-lg border text-sm">
          <li className="flex items-center gap-2.5 border-b px-3 py-2.5">
            <Check className="size-4 shrink-0 text-green-600 dark:text-green-500" />
            <span>
              All <strong>{runCount}</strong> {runCount === 1 ? "run" : "runs"}{" "}
              and their files are kept and stay browsable
            </span>
          </li>
          <li
            className={cn(
              "flex items-center gap-2.5 px-3 py-2.5",
              hasWatchers && "border-b"
            )}
          >
            <Check className="size-4 shrink-0 text-green-600 dark:text-green-500" />
            <span>Nothing is deleted from storage — this is reversible</span>
          </li>
          {hasWatchers ? (
            <li className="flex items-center gap-2.5 px-3 py-2.5">
              <Power className="size-4 shrink-0 text-muted-foreground" />
              <span>
                Its <strong>{watcherCount}</strong>{" "}
                {watcherCount === 1 ? "watcher" : "watchers"} will be
                deregistered so {watcherCount === 1 ? "it stops" : "they stop"}{" "}
                heartbeating
              </span>
            </li>
          ) : null}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={handleRetire}
            variant="destructive"
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Retire instrument
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
