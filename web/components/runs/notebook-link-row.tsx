"use client";

import {
  Copy,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
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
  type NotebookLinkWire,
  notebookLinkCreator,
} from "@/lib/api/run-notebook-link-wire";

/**
 * One lab notebook link on the run page: its name, and who added it and
 * when. They share a line on wider screens and stack on narrow ones. The
 * menu offers Edit and Remove unless `readOnly`, and Copy link always.
 */
export function NotebookLinkRow({
  link,
  readOnly,
  onEdit,
  onRemove,
}: {
  link: NotebookLinkWire;
  readOnly: boolean;
  onEdit: () => void;
  // Resolves true once the link is gone.
  onRemove: () => Promise<boolean>;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const creator = notebookLinkCreator(link);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link.url);
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
        <TruncatedTooltip text={link.display_name}>
          <a
            className="min-w-0 truncate font-medium text-sm underline-offset-2 hover:underline"
            href={link.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            {link.display_name}
          </a>
        </TruncatedTooltip>
        {/* On narrow screens the time gets its own line, so the dot that
            separates it only shows when everything fits on one. */}
        <span className="flex flex-col gap-0.5 whitespace-nowrap text-muted-foreground text-xs sm:shrink-0 sm:flex-row sm:items-center sm:gap-1">
          <span className="inline-flex items-center gap-1">
            {creator ? (
              <>
                Added by
                <ActorLabel
                  actor={creator}
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
          <RelativeTime date={link.created_at} />
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for ${link.display_name}`}
            className="-my-1 -mr-1 size-7 shrink-0 text-muted-foreground/70 hover:text-foreground"
            size="icon"
            type="button"
            variant="ghost"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          {readOnly ? null : (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="size-3.5" />
              Edit
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={copyLink}>
            <Copy className="size-3.5" />
            Copy link
          </DropdownMenuItem>
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
                <Trash2 className="size-3.5" />
                Remove
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        confirmLabel="Remove"
        description={`“${link.display_name}” will no longer be linked from this run. The page itself isn't changed.`}
        onConfirm={onRemove}
        onOpenChange={setRemoveOpen}
        open={removeOpen}
        title="Remove this notebook link?"
        variant="destructive"
      />
    </div>
  );
}
