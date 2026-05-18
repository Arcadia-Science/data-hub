"use client";

import { Button } from "@/components/ui/button";
import { Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

export function RestoreRunButton({
  instrumentId,
  runId,
}: {
  instrumentId: string;
  runId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleRestore() {
    startTransition(async () => {
      const res = await fetch(
        `/api/v1/instruments/${instrumentId}/runs/${runId}/restore`,
        { method: "POST" }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to restore run");
        return;
      }

      toast.success("Run restored");
      router.refresh();
    });
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1 text-xs"
      onClick={handleRestore}
      disabled={isPending}
    >
      {isPending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <RotateCcw className="size-3" />
      )}
      Restore
    </Button>
  );
}
