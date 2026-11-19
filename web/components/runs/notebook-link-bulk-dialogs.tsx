"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import type { RunRef } from "@/components/instruments/runs-table/run-selection-provider";
import {
  NotebookPickerForm,
  type NotebookPickerValues,
} from "@/components/runs/notebook-picker-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useReturnFocus } from "@/hooks/use-return-focus";
import { fanOutAttribution } from "@/lib/runs/attribution-requests";
import {
  addRunsSummary,
  notebooksOfRuns,
  removeRunsSummary,
  runsLabel,
} from "@/lib/runs/notebook-outcomes";
import {
  addRunsToPick,
  type NotebookPick,
  NotebookRequestError,
  removeRunsFromNotebook,
} from "@/lib/runs/notebook-requests";
import { settleWithConcurrency } from "@/lib/runs/settle-with-concurrency";

// Removing runs from several notebooks sends one request per notebook, this
// many at a time.
const REMOVE_REQUEST_CONCURRENCY = 4;

/** The URL without its scheme, which every link shares. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function runKey(run: { instrumentId: string; runId: string }): string {
  return `${run.instrumentId}\u0000${run.runId}`;
}

/**
 * Adds every selected run to one notebook, picked by name or by a pasted
 * link. Runs already in the notebook are skipped, and the picker says how
 * many before you save.
 */
export function AddToNotebookDialog({
  open,
  onOpenChange,
  runRefs,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runRefs: RunRef[];
  onComplete: () => void;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const count = runRefs.length;

  async function handleSave(
    pick: NotebookPick,
    values: NotebookPickerValues
  ): Promise<string | null> {
    let saved: Awaited<ReturnType<typeof addRunsToPick>>;
    try {
      saved = await addRunsToPick(pick, runRefs);
    } catch (error) {
      return error instanceof NotebookRequestError &&
        (error.status === 400 || error.status === 409)
        ? error.message
        : "Couldn't add the runs. Try again?";
    }

    const { notebook, result } = saved;
    const summary = addRunsSummary(notebook.name, result.counts);
    if (summary.tone === "warning") {
      toast.warning(summary.message);
    } else {
      toast.success(summary.message);
    }

    if (values.claim) {
      const inNotebook = new Set(
        result.results
          .filter(
            (r) =>
              r.outcome === "added" || r.outcome === "already_in_lab_notebook"
          )
          .map((r) =>
            runKey({ instrumentId: r.instrument_id, runId: r.run_id })
          )
      );
      const { failed } = await fanOutAttribution(
        "PUT",
        runRefs.filter((ref) => inNotebook.has(runKey(ref)))
      );
      if (failed > 0) {
        toast.error(
          `Couldn't mark you as having run ${runsLabel(failed)}. Try "I ran these" again.`
        );
      }
    }

    onOpenChange(false);
    onComplete();
    router.refresh();
    return null;
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent {...returnFocus}>
        <DialogHeader>
          <DialogTitle>Add {runsLabel(count)} to a lab notebook</DialogTitle>
          <DialogDescription>
            Find a lab notebook by name, or paste a link to its page. Runs
            already in the lab notebook are skipped.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <NotebookPickerForm
            claimLabel={count === 1 ? "I ran this run" : "I ran these runs"}
            onCancel={() => onOpenChange(false)}
            onSave={handleSave}
            runNotebookIds={runRefs.map((ref) =>
              ref.notebooks.map((notebook) => notebook.id)
            )}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Lists the notebooks the selected runs are in, with how many of the runs
 * are in each, and takes the selected runs out of the ones you tick.
 */
export function RemoveFromNotebooksDialog({
  open,
  onOpenChange,
  runRefs,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runRefs: RunRef[];
  onComplete: () => void;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const id = useId();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  const notebooks = notebooksOfRuns(runRefs);
  const count = runRefs.length;
  const affected = runRefs.filter((ref) =>
    ref.notebooks.some((notebook) => chosen.has(notebook.id))
  ).length;

  function toggle(notebookId: string, checked: boolean) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(notebookId);
      } else {
        next.delete(notebookId);
      }
      return next;
    });
  }

  function handleOpenChange(next: boolean) {
    if (isPending) {
      return;
    }
    if (!next) {
      setChosen(new Set());
    }
    onOpenChange(next);
  }

  function handleRemove() {
    const targets = notebooks.filter((notebook) => chosen.has(notebook.id));
    startTransition(async () => {
      // Each notebook gets only the selected runs that are in it.
      const results = await settleWithConcurrency(
        targets,
        REMOVE_REQUEST_CONCURRENCY,
        (notebook) =>
          removeRunsFromNotebook(
            notebook.id,
            runRefs.filter((ref) =>
              ref.notebooks.some((entry) => entry.id === notebook.id)
            )
          )
      );
      const removedRuns = new Set<string>();
      let failedNotebooks = 0;
      for (const settled of results) {
        if (settled.status === "rejected") {
          failedNotebooks += 1;
          continue;
        }
        for (const r of settled.value.results) {
          if (r.outcome === "removed") {
            removedRuns.add(
              runKey({ instrumentId: r.instrument_id, runId: r.run_id })
            );
          }
        }
      }
      const summary = removeRunsSummary({
        failedNotebooks,
        notebookNames: targets.map((notebook) => notebook.name),
        removedRuns: removedRuns.size,
      });
      if (summary.tone === "error") {
        toast.error(summary.message);
        return;
      }
      if (summary.tone === "warning") {
        toast.warning(summary.message);
      } else {
        toast.success(summary.message);
      }
      setChosen(new Set());
      onOpenChange(false);
      onComplete();
      router.refresh();
    });
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent {...returnFocus}>
        <DialogHeader>
          <DialogTitle>
            Remove {runsLabel(count)} from lab notebooks
          </DialogTitle>
          <DialogDescription>
            Choose the lab notebooks to take the selected runs out of. Their
            other lab notebooks stay, and the lab notebooks themselves aren't
            changed.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-72 flex-col overflow-y-auto">
          {notebooks.map((notebook, index) => {
            const checkboxId = `${id}-${index}`;
            return (
              <li
                className="flex items-start gap-3 border-t py-2.5 first:border-t-0"
                key={notebook.id}
              >
                <Checkbox
                  checked={chosen.has(notebook.id)}
                  className="mt-0.5"
                  disabled={isPending}
                  id={checkboxId}
                  onCheckedChange={(checked) =>
                    toggle(notebook.id, checked === true)
                  }
                />
                <label className="flex min-w-0 flex-col" htmlFor={checkboxId}>
                  <span className="truncate font-medium text-sm">
                    {notebook.name}
                  </span>
                  <span className="truncate text-muted-foreground text-xs">
                    {shortUrl(notebook.url)} · has {notebook.runCount} of{" "}
                    {runsLabel(count)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button
            disabled={isPending}
            onClick={() => handleOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={isPending || chosen.size === 0}
            onClick={handleRemove}
            type="button"
            variant="destructive"
          >
            {isPending ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : null}
            {affected > 0 ? `Remove ${runsLabel(affected)}` : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
