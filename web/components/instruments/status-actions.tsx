"use client";

import { Button } from "@/components/ui/button";
import { Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

// Instruments registered by a watcher start as "pending" and require admin
// approval. This button transitions them to "active" via the PATCH API.
export function StatusActions({ instrumentId }: { instrumentId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      const res = await fetch(`/api/v1/instruments/${instrumentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to confirm instrument");
        return;
      }

      toast.success("Instrument confirmed");
      router.refresh();
    });
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleConfirm}
      disabled={isPending}
      className="h-7 gap-1 text-xs"
    >
      {isPending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Check className="size-3" />
      )}
      Confirm
    </Button>
  );
}
