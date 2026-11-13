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

/** The URL without its scheme, which every link shares. */
export function notebookLinkShortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * One lab notebook link on the run page: its name, the URL, and who added
 * it. The menu offers Edit and Remove unless `readOnly`, and Copy link always.
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
    <div className="flex items-start gap-3 px-4 py-3">
      <ExternalLink
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <TruncatedTooltip text={link.display_name}>
          <a
            className="truncate font-medium text-sm underline-offset-2 hover:underline"
            href={link.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            {link.display_name}
          </a>
        </TruncatedTooltip>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
          <TruncatedTooltip text={link.url}>
            <span className="max-w-full truncate" tabIndex={0}>
              {notebookLinkShortUrl(link.url)}
            </span>
          </TruncatedTooltip>
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
            <span aria-hidden="true">·</span>
            <RelativeTime date={link.created_at} />
          </span>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for ${link.display_name}`}
            className="-mt-1 -mr-1 size-7 shrink-0 text-muted-foreground/70 hover:text-foreground"
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
