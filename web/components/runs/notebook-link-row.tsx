"use client";

import { ExternalLink, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { ActorLabel } from "@/components/token-actor";
import { TruncatedTooltip } from "@/components/truncated-tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type RunNotebookWire,
  runNotebookLinker,
} from "@/lib/api/notebook-wire";

/**
 * One lab notebook on the run page: its name, which opens the notebook's
 * page, and who added the run and when. They share a line on wider screens
 * and stack on narrow ones. The menu offers Copy link always, and Remove
 * from notebook unless `readOnly`.
 */
export function NotebookLinkRow({
  notebook,
  readOnly,
  onRemove,
}: {
  notebook: RunNotebookWire;
  readOnly: boolean;
  // Resolves true once the run is out of the notebook.
  onRemove: () => Promise<boolean>;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const linker = runNotebookLinker(notebook);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(notebook.url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link.");
    }
  }

  return (
    <div className="flex items-start gap-3 px-4 py-3 sm:items-center">
      <ExternalLink
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground sm:mt-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <TruncatedTooltip text={notebook.name}>
          <a
            className="min-w-0 truncate font-medium text-sm underline-offset-2 hover:underline"
            href={notebook.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            {notebook.name}
          </a>
        </TruncatedTooltip>
        {/* On narrow screens the time gets its own line, so the dot that
            separates it only shows when everything fits on one. */}
        <span className="flex flex-col gap-0.5 whitespace-nowrap text-muted-foreground text-xs sm:shrink-0 sm:flex-row sm:items-center sm:gap-1">
          <span className="inline-flex items-center gap-1">
            {linker ? (
              <>
                Added by
                <ActorLabel
                  actor={linker}
                  nameClassName="font-medium text-foreground"
                />
              </>
            ) : (
              "Added"
            )}
          </span>
          <span aria-hidden="true" className="hidden sm:inline">
            ·
          </span>
          <RelativeTime date={notebook.linked_at} />
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for ${notebook.name}`}
            className="-my-1 -mr-1 size-7 shrink-0 text-muted-foreground/70 hover:text-foreground"
            size="icon"
            type="button"
            variant="ghost"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          <DropdownMenuItem onSelect={copyLink}>Copy link</DropdownMenuItem>
          {readOnly ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setRemoveOpen(true);
                }}
                variant="destructive"
              >
                Remove from lab notebook
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        confirmLabel="Remove"
        description={`This run will no longer be in “${notebook.name}”. The lab notebook and its page aren't changed.`}
        onConfirm={onRemove}
        onOpenChange={setRemoveOpen}
        open={removeOpen}
        title="Remove this run from the lab notebook?"
        variant="destructive"
      />
    </div>
  );
}
