"use client";

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { useRunSelection, type RunRef } from "./run-selection-provider";

async function fanOut(
  method: "PUT" | "DELETE",
  refs: RunRef[]
): Promise<{ ok: number; failed: number }> {
  const results = await Promise.all(
    refs.map(async (ref) => {
      const url = `/api/v1/instruments/${ref.instrumentId}/runs/${encodeURIComponent(
        ref.runId
      )}/attributions/me`;
      try {
        const res = await fetch(url, { method });
        return res.ok;
      } catch {
        return false;
      }
    })
  );
  const ok = results.filter(Boolean).length;
  return { ok, failed: results.length - ok };
}

export function BulkAttributionBar() {
  const { state, actions, meta } = useRunSelection();
  const router = useRouter();
  const [isPending, startMutation] = useTransition();

  if (meta.count === 0) return null;

  const refs = Array.from(state.selected.values());

  function runAction(method: "PUT" | "DELETE", label: string) {
    startMutation(async () => {
      const { ok, failed } = await fanOut(method, refs);
      if (failed === 0) {
        toast.success(`${label} ${ok} ${ok === 1 ? "run" : "runs"}.`);
      } else if (ok === 0) {
        toast.error(
          `Failed to update ${failed} ${failed === 1 ? "run" : "runs"}.`
        );
      } else {
        toast.warning(
          `${label} ${ok} ${ok === 1 ? "run" : "runs"}, ${failed} failed.`
        );
      }
      actions.clear();
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-4 py-2">
      <div className="text-sm">
        <span className="font-medium">{meta.count}</span>{" "}
        <span className="text-muted-foreground">
          {meta.count === 1 ? "run" : "runs"} selected
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={isPending}
          onClick={() => runAction("PUT", "Claimed")}
        >
          I ran these
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={() => runAction("DELETE", "Removed attribution from")}
        >
          Remove my attribution
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => actions.clear()}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
