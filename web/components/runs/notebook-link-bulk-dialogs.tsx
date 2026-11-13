"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import type { RunRef } from "@/components/instruments/runs-table/run-selection-provider";
import {
  NotebookLinkForm,
  type NotebookLinkFormValues,
} from "@/components/runs/notebook-link-form";
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
import {
  NOTEBOOK_LINK_BULK_URLS_MAX,
  notebookUrlKey,
} from "@/lib/notebook-links/url";
import { fanOutAttribution } from "@/lib/runs/attribution-requests";
import {
  bulkAddNotebookLink,
  bulkRemoveNotebookLinks,
  NotebookLinkRequestError,
} from "@/lib/runs/notebook-link-requests";

/** The URL without its scheme, which every link shares. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function runs(count: number): string {
  return `${count} ${count === 1 ? "run" : "runs"}`;
}

function runKey(run: { instrumentId: string; runId: string }): string {
  return `${run.instrumentId}\u0000${run.runId}`;
}

/**
 * Adds one notebook link to every selected run. Runs that already link to
 * the page are skipped, and the dialog says how many before you save.
 */
export function AddNotebookLinkDialog({
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

  function alreadyLinked(url: string): number {
    const key = notebookUrlKey(url);
    if (!key) {
      return 0;
    }
    return runRefs.filter((ref) =>
      ref.notebookLinks.some((link) => link.urlKey === key)
    ).length;
  }

  async function handleSave(
    values: NotebookLinkFormValues
  ): Promise<string | null> {
    let result: Awaited<ReturnType<typeof bulkAddNotebookLink>>;
    try {
      result = await bulkAddNotebookLink(runRefs, {
        url: values.url,
        label: values.label,
      });
    } catch (error) {
      return error instanceof NotebookLinkRequestError && error.status === 400
        ? error.message
        : "Couldn't add the link. Try again?";
    }

    const { added, already_linked, limit_reached, not_found, run_deleted } =
      result.counts;
    const parts = [`Added to ${runs(added)}.`];
    if (already_linked > 0) {
      parts.push(`${runs(already_linked)} already had it.`);
    }
    if (limit_reached > 0) {
      parts.push(`${runs(limit_reached)} already had the most links allowed.`);
    }
    if (not_found + run_deleted > 0) {
      parts.push(`${runs(not_found + run_deleted)} couldn't be changed.`);
    }
    const message = parts.join(" ");
    if (limit_reached + not_found + run_deleted > 0) {
      toast.warning(message);
    } else {
      toast.success(message);
    }

    if (values.claim) {
      const linked = new Set(
        result.results
          .filter(
            (r) => r.outcome === "added" || r.outcome === "already_linked"
          )
          .map((r) =>
            runKey({ instrumentId: r.instrument_id, runId: r.run_id })
          )
      );
      const { failed } = await fanOutAttribution(
        "PUT",
        runRefs.filter((ref) => linked.has(runKey(ref)))
      );
      if (failed > 0) {
        toast.error(
          `Couldn't mark you as having run ${runs(failed)}. Try "I ran these" again.`
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
          <DialogTitle>Add a notebook link to {runs(count)}</DialogTitle>
          <DialogDescription>
            Runs that already link to this page are skipped.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <NotebookLinkForm
            claimLabel={count === 1 ? "I ran this run" : "I ran these runs"}
            note={(url) => {
              const existing = alreadyLinked(url);
              return existing > 0 ? (
                <p className="rounded-md bg-muted px-3 py-2 text-muted-foreground text-sm">
                  {existing} of the {runs(count)} already{" "}
                  {existing === 1 ? "has" : "have"} this link.
                </p>
              ) : null;
            }}
            onCancel={() => onOpenChange(false)}
            onSave={handleSave}
            variant="add"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface DistinctLink {
  displayName: string;
  runCount: number;
  url: string;
  urlKey: string;
}

function distinctLinks(runRefs: RunRef[]): DistinctLink[] {
  const byKey = new Map<string, DistinctLink>();
  for (const ref of runRefs) {
    for (const link of ref.notebookLinks) {
      const entry = byKey.get(link.urlKey);
      if (entry) {
        entry.runCount += 1;
      } else {
        byKey.set(link.urlKey, {
          urlKey: link.urlKey,
          url: link.url,
          displayName: link.displayName,
          runCount: 1,
        });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.runCount - a.runCount);
}

/**
 * Lists the distinct notebook links on the selected runs, with how many runs
 * have each, and removes the ones you tick from every selected run.
 */
export function RemoveNotebookLinksDialog({
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

  const links = distinctLinks(runRefs);
  const count = runRefs.length;
  const affected = runRefs.filter((ref) =>
    ref.notebookLinks.some((link) => chosen.has(link.urlKey))
  ).length;
  const tooMany = chosen.size > NOTEBOOK_LINK_BULK_URLS_MAX;

  function toggle(urlKey: string, checked: boolean) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(urlKey);
      } else {
        next.delete(urlKey);
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
    const urls = links
      .filter((link) => chosen.has(link.urlKey))
      .map((link) => link.url);
    startTransition(async () => {
      try {
        const result = await bulkRemoveNotebookLinks(runRefs, urls);
        toast.success(`Removed links from ${runs(result.counts.removed)}.`);
      } catch {
        toast.error("Couldn't remove the links. Try again?");
        return;
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
          <DialogTitle>Remove notebook links from {runs(count)}</DialogTitle>
          <DialogDescription>
            Choose the links to remove. Other links stay, and the pages
            themselves aren't changed.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-72 flex-col overflow-y-auto">
          {links.map((link, index) => {
            const checkboxId = `${id}-${index}`;
            return (
              <li
                className="flex items-start gap-3 border-t py-2.5 first:border-t-0"
                key={link.urlKey}
              >
                <Checkbox
                  checked={chosen.has(link.urlKey)}
                  className="mt-0.5"
                  disabled={isPending}
                  id={checkboxId}
                  onCheckedChange={(checked) =>
                    toggle(link.urlKey, checked === true)
                  }
                />
                <label className="flex min-w-0 flex-col" htmlFor={checkboxId}>
                  <span className="truncate font-medium text-sm">
                    {link.displayName}
                  </span>
                  <span className="truncate text-muted-foreground text-xs">
                    {shortUrl(link.url)} · on {link.runCount} of {runs(count)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {tooMany ? (
          <p className="text-destructive text-sm">
            Remove at most {NOTEBOOK_LINK_BULK_URLS_MAX} links at a time.
          </p>
        ) : null}
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
            disabled={isPending || chosen.size === 0 || tooMany}
            onClick={handleRemove}
            type="button"
            variant="destructive"
          >
            {isPending ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : null}
            {affected > 0 ? `Remove from ${runs(affected)}` : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
